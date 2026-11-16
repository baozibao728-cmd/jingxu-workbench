import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';
import {ProjectStore,digest} from '../src/project-store.js';import {createApplication} from '../src/server.js';
import {ZipWriter,ZipReader} from '../src/zip.js';

const config=()=>({deepseek:{apiKey:'secret-text-key',baseUrl:'https://text.example',model:'mock'},grsai:{apiKey:'secret-image-key',baseUrl:'https://image.example',model:'mock'},fydmai:{apiKey:'secret-video-key',baseUrl:'https://video.example',model:'c7-wan3'},minimax:{apiKey:'',baseUrl:'https://api.minimax.cn',model:'speech-2.8-hd'}});
async function app(root){await writeFile(join(root,'package.json'),'{"version":"1.0.0"}');const a=await createApplication({root,config:config(),seedDemo:false,updateRoot:root});await new Promise(r=>a.server.listen(0,'127.0.0.1',r));return{...a,base:'http://127.0.0.1:'+a.server.address().port,close:async()=>{a.workflow.stopping=true;await new Promise(r=>a.server.close(r));}};}
async function seed(a){
 const p=await a.store.create({title:'导出测试：第一集',script:'场景一：房间\n主角：“台词。”\n'});const image=Buffer.from('fake-image-bytes'),video=Buffer.from('fake-video-bytes'.repeat(500));
 await writeFile(a.store.media(p.id,'hero.png'),image);await writeFile(a.store.media(p.id,'clip.mp4'),video);
 p.assets=[{id:'hero-id',sourceKey:'hero',name:'主角',kind:'character',selected:true,description:'造型',prompt:'p',history:[],job:{state:'running',taskId:'remote-1',providerId:'x'},image:{file:'hero.png',filename:'hero.png',sha256:digest(image)}},{id:'lost-id',name:'缺图',kind:'prop',history:[],job:{state:'idle'},image:{file:'missing.png',sha256:'x'}}];
 p.shots=[{id:'s1',title:'分镜一',duration:15,promptTemplate:'{{ref:hero-id}} 动作',assetIds:['hero-id'],audioIds:['no-such-audio'],history:[],job:{state:'completed',taskId:'remote-2',snapshot:{providerId:'x'}},video:{file:'clip.mp4',duration:15,inputHash:'old-machine-hash'}}];
 p.videoProviderId='old-machine-provider';await a.store.save(p);return{p,image,video};
}

test('ZIP 读写往返一致，能被系统自带的 unzip 解开，损坏和越界内容会被拒绝',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jingxu-zip-'));try{const path=join(root,'a.zip'),chunks=[];const w=new ZipWriter(c=>{chunks.push(c);});
  await w.add('说明.json',JSON.stringify({a:'中文'}),{compress:true});await w.add('projects/1/media/图.png',Buffer.from([1,2,3,4,5]));await w.finish();await writeFile(path,Buffer.concat(chunks));
  const r=await ZipReader.open(path);assert.deepEqual(r.entries.map(e=>e.name),['说明.json','projects/1/media/图.png']);assert.equal((await r.read(r.entries[0])).toString(),'{"a":"中文"}');assert.deepEqual([...await r.read(r.entries[1])],[1,2,3,4,5]);await r.close();
  let unzip=true;try{execFileSync('unzip',['-tq',path]);}catch(e){if(e.code==='ENOENT')unzip=false;else throw e;}if(unzip)assert.match(execFileSync('unzip',['-l',path]).toString(),/2 files/);
  const bad=Buffer.concat(chunks);bad[bad.indexOf(Buffer.from([1,2,3,4,5]))]=9;await writeFile(path,bad);const r2=await ZipReader.open(path);await assert.rejects(r2.read(r2.entries[1]),/校验失败/);await r2.close();
  await writeFile(path,'not a zip at all, just text');await assert.rejects(ZipReader.open(path),/ZIP/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('导出的包不含 Key 和原电脑的任务状态；导入到另一台电脑后资产图、视频、分镜都在，已完成的视频不变成需重做',async()=>{
 const rootA=await mkdtemp(join(tmpdir(),'jingxu-export-a-')),rootB=await mkdtemp(join(tmpdir(),'jingxu-export-b-'));let a,b;
 try{a=await app(rootA);const {p,image,video}=await seed(a);
  const denied=await fetch(a.base+'/api/projects/export?ids=nope');assert.equal(denied.status,404);assert.equal((await fetch(a.base+'/api/projects/export')).status,400);
  const res=await fetch(a.base+`/api/projects/export?ids=${p.id}`);assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),'application/zip');assert.match(res.headers.get('content-disposition'),/filename\*=UTF-8''/);
  const zip=Buffer.from(await res.arrayBuffer());for(const secret of ['secret-text-key','secret-image-key','secret-video-key','remote-1','remote-2','old-machine-provider'])assert.ok(!zip.includes(secret),secret);
  assert.equal(a.store.get(p.id).assets[0].job.taskId,'remote-1');
  b=await app(rootB);const headers={'Content-Type':'application/zip','X-Workflow-Token':b.token};
  const junk=await fetch(b.base+'/api/projects/import',{method:'POST',headers,body:Buffer.from('this is not a zip file, sorry')});assert.equal(junk.status,400);assert.equal(b.store.list().length,0);
  const done=await fetch(b.base+'/api/projects/import',{method:'POST',headers,body:zip});assert.equal(done.status,201);const out=await done.json();assert.equal(out.imported.length,1);assert.equal(out.projects.length,1);
  const id=out.imported[0].id;assert.notEqual(id,p.id);const view=await(await fetch(b.base+'/api/projects/'+id)).json();
  assert.equal(view.title,'导出测试：第一集');assert.equal(view.assets[0].job.state,'completed');assert.equal(view.assets[1].image,undefined);assert.equal(view.shots[0].stale,false);assert.deepEqual(view.shots[0].audioIds,[]);assert.equal(view.shots[0].job.taskId,undefined);assert.equal(view.skipReview,false);
  assert.deepEqual(await readFile(b.store.media(id,'hero.png')),image);assert.deepEqual(await readFile(b.store.media(id,'clip.mp4')),video);
  assert.equal(Buffer.from(await(await fetch(b.base+view.assets[0].image.url)).arrayBuffer()).toString(),'fake-image-bytes');
  const again=await(await fetch(b.base+'/api/projects/import',{method:'POST',headers,body:zip})).json();assert.equal(again.projects.length,2);
  assert.equal((await fetch(b.base+'/api/projects/import',{method:'POST',headers:{'Content-Type':'application/zip'},body:'x'})).status,403);assert.equal(b.store.list().length,2);
 }finally{await a?.close();await b?.close();await rm(rootA,{recursive:true,force:true});await rm(rootB,{recursive:true,force:true});}
});

test('包里的路径不能写到项目目录之外',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jingxu-import-evil-'));let a;try{a=await app(root);const chunks=[];const w=new ZipWriter(c=>{chunks.push(c);});
  await w.add('projects/1/project.json',JSON.stringify({title:'x',assets:[{id:'a',name:'n',kind:'prop',image:{file:'../../evil.png'}}],shots:'bad'}),{compress:true});
  await w.add('projects/1/media/../../evil.png','evil');await w.add('projects/1/media/project.json','{"id":"evil"}');await w.add('projects/1/media/ok.png','ok');await w.finish();
  const res=await fetch(a.base+'/api/projects/import',{method:'POST',headers:{'Content-Type':'application/zip','X-Workflow-Token':a.token},body:Buffer.concat(chunks)});assert.equal(res.status,201);
  const id=(await res.json()).imported[0].id,p=a.store.get(id);assert.deepEqual((await readdir(join(root,'data','projects',id)).catch(()=>readdir(a.store.directory(id)))).sort(),['ok.png','project.json']);
  assert.equal(p.assets[0].image,undefined);assert.deepEqual(p.shots,[]);assert.equal(JSON.parse(await readFile(join(a.store.directory(id),'project.json'),'utf8')).id,id);
 }finally{await a?.close();await rm(root,{recursive:true,force:true});}
});
