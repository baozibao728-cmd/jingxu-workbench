import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {resolvePrompts,renderStoryboardFormat} from '../src/prompt-settings.js';
import {Workflow} from '../src/workflow.js';import {ProjectStore,digest} from '../src/project-store.js';

test('不内置任何提示词规则；自己填的分镜模板按时长和画幅替换占位符，素材引用原样保留',()=>{
 const defaults=resolvePrompts();assert.deepEqual(Object.values(defaults),['','','','','']);
 assert.equal(resolvePrompts({breakdown:'  我的规则  '}).breakdown,'我的规则');
 const template='【时长】{{DURATION}}秒 {{FRAME_DESCRIPTION}}{{VERTICAL_SAFETY}} {{ref:资产key}}';
 const vertical=renderStoryboardFormat(template,{duration:30,aspectRatio:'9:16'});
 assert.match(vertical,/【时长】30秒/);assert.match(vertical,/竖屏9:16剧情短剧构图/);assert.match(vertical,/底部五分之一/);
 const horizontal=renderStoryboardFormat(template,{duration:15,aspectRatio:'16:9'});
 assert.match(horizontal,/【时长】15秒/);assert.match(horizontal,/横屏16:9剧情短剧构图/);assert.ok(!horizontal.includes('底部五分之一'));
 assert.ok(!/\{\{(?:DURATION|FRAME_|BLOCKING|PHONE_|VERTICAL_)/.test(horizontal));
 assert.match(horizontal,/\{\{ref:资产key\}\}/);
 assert.equal(renderStoryboardFormat('',{duration:30,aspectRatio:'16:9'}),'');
});

test('新分镜与AI重拆实际收到自己填写的模板，生成超过9张参考图时不落盘',async()=>{
 const root=await mkdtemp(join(tmpdir(),'drama-format-'));const store=new ProjectStore(root);await store.init();
 const p=await store.create({script:'场景一：主角说话。',clipDuration:30,aspectRatio:'9:16'});let tooMany=false;const calls=[];
 const config=()=>({deepseek:{apiKey:'fake'},grsai:{apiKey:'fake'},fydmai:{apiKey:'fake',model:'c7-wan3',baseUrl:'https://video.example'}});
 const workflow=new Workflow(store,config,{getPrompts:()=>resolvePrompts({breakdown:'我的拆解规则',storyboardFormat:'【时长】{{DURATION}}秒 我的版式模板'}),factories:{text:()=>({generateJson:async request=>{calls.push(request);return{shots:[{title:'对白',duration:30,promptTemplate:tooMany?p.assets.map(a=>`{{ref:${a.sourceKey}}}`).join(' '):'{{ref:a0}} 0-30秒说话。'}]};}})}});
 try{
  const bytes=Buffer.from('fake');await writeFile(store.media(p.id,'a.png'),bytes);
  p.assets=Array.from({length:10},(_,i)=>({id:`a${i}`,sourceKey:`a${i}`,kind:i?'prop':'character',name:`素材${i}`,selected:true,image:{file:'a.png',filename:'a.png',sha256:digest(bytes)}}));
  await workflow.generateStoryboards(p);
  assert.match(calls[0].instructions,/我的拆解规则/);assert.match(calls[0].instructions,/我的版式模板/);assert.match(calls[0].instructions,/每条引用1～9张/);assert.match(calls[0].instructions,/【时长】30秒/);
  await workflow.rebuildShot(p.id,p.shots[0].id,{duration:30});await workflow.active.get(`rebuild:${p.id}:${p.shots[0].id}`);
  assert.match(calls[1].instructions,/我的版式模板/);assert.match(calls[1].instructions,/最多9张图片/);
  assert.equal(JSON.parse(calls[1].input).consistencyAnchors.length,1);
  tooMany=true;const old=p.shots[0];await workflow.rebuildShot(p.id,old.id,{duration:30});await workflow.active.get(`rebuild:${p.id}:${old.id}`);
  assert.equal(p.shots[0],old);assert.equal(old.rebuildJob.state,'failed');
 }finally{workflow.stopping=true;await Promise.allSettled([...workflow.active.values()]);await rm(root,{recursive:true,force:true});}
});
