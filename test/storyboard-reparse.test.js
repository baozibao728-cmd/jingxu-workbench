import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Workflow} from '../src/workflow.js';import {ProjectStore,digest} from '../src/project-store.js';import {splitScript} from '../src/script-chunks.js';import {createApplication} from '../src/server.js';
const config=()=>({deepseek:{apiKey:'fake-text',baseUrl:'https://text.example',model:'mock'},grsai:{apiKey:'fake-image',baseUrl:'https://image.example',model:'mock'},fydmai:{apiKey:'fake-video',baseUrl:'https://video.example',model:'c7-wan3'}});
async function fixture(count=3){
 const root=await mkdtemp(join(tmpdir(),'jingxu-reparse-')),store=new ProjectStore(root);await store.init();const project=await store.create({script:Array.from({length:count},(_,i)=>`场景${i+1}：房间\n主角：“第${i+1}句原文。”\n`).join(''),skipReview:true});
 const bytes=Buffer.from('fake-image');await writeFile(store.media(project.id,'hero.png'),bytes);await writeFile(store.media(project.id,'old.mp4'),'old-clip');
 project.assets=[{id:'hero-id',sourceKey:'hero',name:'主角',kind:'character',selected:true,description:'同一造型',job:{state:'completed'},image:{file:'hero.png',sha256:digest(bytes),filename:'hero.png'}}];
 project.chunks=splitScript(project.script);project.chunks.forEach(c=>{c.analysisState='completed';c.storyboardState='completed';c.assetIds=['hero-id'];});project.shots=[{id:'old',title:'旧分镜',duration:15,promptTemplate:'{{ref:hero-id}} 旧内容',assetIds:['hero-id'],history:[],job:{state:'completed'},video:{file:'old.mp4',duration:15}}];project.mergedVideo={file:'old.mp4',clips:1};await store.save(project);
 const calls=[];let images=0,videos=0,failAt=0;let gate;
 const factories={text:()=>({generateJson:async req=>{const input=JSON.parse(req.input);calls.push({input,instructions:req.instructions});if(gate)await gate;if(input.chunkIndex===failAt)throw Error('模拟分段中断');return{shots:[{title:'新分镜'+input.chunkIndex,duration:30,promptTemplate:`{分镜${input.firstSegmentNumber}}\n{{ref:hero}} ${input.script}`} ]};}}),image:()=>({submit:async()=>{images++;throw Error('不得生图');}}),video:()=>({submit:async()=>{videos++;throw Error('不得生视频');}})};
 const workflow=new Workflow(store,config,{factories});const settle=()=>workflow.active.get(`reparse:${project.id}`);
 return{root,store,project,workflow,calls,factories,settle,setFailure:n=>failAt=n,setGate:p=>gate=p,counts:()=>({images,videos}),cleanup:async()=>{workflow.stopping=true;await Promise.allSettled([...workflow.active.values()]);await rm(root,{recursive:true,force:true});}};
}

test('整剧45段按顺序全部重解析，保持原文并逐段承接；旧镜头和成片存历史，跳过检查开启也不生成视频',async()=>{
 const f=await fixture(45);try{const before=structuredClone(f.project.shots);await f.workflow.reparseStoryboards(f.project.id,{duration:30,notes:'保持全部台词'});await f.settle();assert.equal(f.project.storyboardReparse.state,'completed');assert.equal(f.project.shots.length,45);assert.equal(f.calls.length,45);for(let i=0;i<45;i++){assert.equal(f.calls[i].input.firstSegmentNumber,i+1);assert.match(f.project.shots[i].promptTemplate,new RegExp(`第${i+1}句原文`));if(i){assert.match(f.calls[i].input.previousEnding.at(-1).prompt,new RegExp(`第${i}句原文`));assert.ok(f.calls[i].input.consistencyAnchors.length);}}
 assert.deepEqual(f.project.storyboardHistory.at(-1).originals,before);assert.equal(f.project.storyboardHistory.at(-1).mergedVideo.file,'old.mp4');assert.equal(await readFile(f.store.media(f.project.id,'old.mp4'),'utf8'),'old-clip');assert.equal(f.project.mergedVideo,undefined);assert.equal(f.project.preparation.phase,'review');assert.equal(f.project.clipDuration,30);assert.deepEqual(f.counts(),{images:0,videos:0});assert.equal(f.workflow.view(f.project).storyboardReparse.draft,undefined);
 }finally{await f.cleanup();}
});

test('全部完成前保留旧分镜，忙碌时不允许重复开始或提交；失败保持旧片且续跑不重复前面已完成段落',async()=>{
 const f=await fixture();let release;try{f.setFailure(2);f.setGate(new Promise(r=>release=r));const old=f.project.shots;await f.workflow.reparseStoryboards(f.project.id,{duration:30});assert.equal(f.project.shots,old);await assert.rejects(f.workflow.reparseStoryboards(f.project.id,{duration:30}),/处理中/);assert.throws(()=>f.workflow.review(f.project.id,['old']),/准备/);release();f.setGate(null);await f.settle();assert.equal(f.project.shots,old);assert.equal(f.project.storyboardReparse.state,'failed');assert.equal(f.project.storyboardReparse.draft.shots.length,1);const saved=JSON.parse(await readFile(join(f.root,f.project.id,'project.json'),'utf8'));assert.equal(saved.shots[0].id,'old');assert.equal(saved.storyboardReparse.draft.shots.length,1);
 f.setFailure(0);await f.workflow.reparseStoryboards(f.project.id,{resume:true});await f.settle();assert.deepEqual(f.calls.map(c=>c.input.chunkIndex),[1,2,2,3]);assert.equal(f.project.shots.length,3);assert.deepEqual(f.counts(),{images:0,videos:0});
 }finally{release?.();await f.cleanup();}
});

test('重启保留未完成解析草稿并能继续；资产改变后拒绝复用过期草稿，未知视频任务禁止覆盖',async()=>{
 const f=await fixture();try{f.setFailure(2);await f.workflow.reparseStoryboards(f.project.id,{duration:30});await f.settle();f.project.storyboardReparse.state='running';f.project.preparation.state='running';await f.store.save(f.project);const store=new ProjectStore(f.root);await store.init();const resumed=new Workflow(store,config,{factories:f.factories});await resumed.recover();const p=store.get(f.project.id);assert.equal(p.storyboardReparse.state,'failed');assert.equal(p.storyboardReparse.draft.shots.length,1);assert.equal(p.shots[0].id,'old');f.setFailure(0);await resumed.reparseStoryboards(p.id,{resume:true});await resumed.active.get(`reparse:${p.id}`);assert.equal(p.shots.length,3);resumed.stopping=true;
 f.project.preparation.state='failed';f.project.storyboardReparse.state='failed';f.project.assets[0].image.sha256='changed';await assert.rejects(f.workflow.reparseStoryboards(f.project.id,{resume:true}),/已更改/);f.project.shots[0].job={state:'unknown'};await assert.rejects(f.workflow.reparseStoryboards(f.project.id,{duration:30}),/视频任务/);assert.deepEqual(f.counts(),{images:0,videos:0});
 }finally{await f.cleanup();}
});

test('HTTP总重解析入口返回后台进度，采用当前规则；失败时不丢旧分镜',async()=>{
 const f=await fixture(2);let app;try{app=await createApplication({root:f.root,config:config(),seedDemo:false,updateRoot:f.root,workflowOptions:{factories:f.factories}}).catch(async e=>{if(e.code!=='ENOENT')throw e;await writeFile(join(f.root,'package.json'),'{"version":"1.1.0"}');return createApplication({root:f.root,config:config(),seedDemo:false,updateRoot:f.root,workflowOptions:{factories:f.factories}});});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;const headers={'Content-Type':'application/json','X-Workflow-Token':app.token};const prompts=await fetch(base+'/api/prompts',{method:'POST',headers,body:JSON.stringify({breakdown:'新的拆解规则'})});assert.equal(prompts.status,200);const response=await fetch(base+`/api/projects/${f.project.id}/reparse-storyboards`,{method:'POST',headers,body:JSON.stringify({duration:30})});assert.equal(response.status,202);await Promise.allSettled([...app.workflow.active.values()]);const p=await(await fetch(base+'/api/projects/'+f.project.id)).json();assert.equal(p.storyboardReparse.state,'completed');assert.equal(p.shots.length,2);assert.equal(p.storyboardReparse.draft,undefined);assert.match(f.calls[0].instructions,/新的拆解规则/);
 }finally{if(app){app.workflow.stopping=true;await new Promise(r=>app.server.close(r));}await f.cleanup();}
});
