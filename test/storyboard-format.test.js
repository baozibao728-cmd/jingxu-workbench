import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {resolvePrompts,renderStoryboardFormat} from '../src/prompt-settings.js';
import {Workflow} from '../src/workflow.js';import {ProjectStore,digest} from '../src/project-store.js';

test('默认完整分镜模板内置并适配30秒竖屏、15秒横屏和真实素材占位符',()=>{
 const template=resolvePrompts().storyboardFormat;
 for(const section of ['【时长】','-人物：','-场景：','-物品：','【风格基调/Style】','【调色基调/Color】','【画面与声音】','【禁止】','六个通道','最多9张','机位A','读音提示'])assert.ok(template.includes(section),section);
 const vertical=renderStoryboardFormat(template,{duration:30,aspectRatio:'9:16'});
 assert.match(vertical,/【时长】30秒/);assert.match(vertical,/竖屏9:16剧情短剧构图/);assert.match(vertical,/底部五分之一/);
 const horizontal=renderStoryboardFormat(template,{duration:15,aspectRatio:'16:9'});
 assert.match(horizontal,/【时长】15秒/);assert.match(horizontal,/横屏16:9剧情短剧构图/);assert.ok(!horizontal.includes('底部五分之一'));
 assert.ok(!/\{\{(?:DURATION|FRAME_|BLOCKING|PHONE_|VERTICAL_)/.test(horizontal));
 assert.match(horizontal,/\{\{ref:资产key\}\}/);
 assert.equal(renderStoryboardFormat('自定义{{DURATION}}秒 {{ref:hero}}',{duration:30,aspectRatio:'16:9'}),'自定义30秒 {{ref:hero}}');
});

test('新分镜与AI重拆实际收到详细模板，生成超过9张参考图时不落盘',async()=>{
 const root=await mkdtemp(join(tmpdir(),'drama-format-'));const store=new ProjectStore(root);await store.init();
 const p=await store.create({script:'场景一：主角说话。',clipDuration:30,aspectRatio:'9:16'});let tooMany=false;const calls=[];
 const config=()=>({deepseek:{apiKey:'fake'},grsai:{apiKey:'fake'},fydmai:{apiKey:'fake',model:'c7-wan3',baseUrl:'https://video.example'}});
 const workflow=new Workflow(store,config,{factories:{text:()=>({generateJson:async request=>{calls.push(request);return{boundaryConfirmation:JSON.parse(request.input).locked,shots:[{title:'对白',duration:30,promptTemplate:tooMany?p.assets.map(a=>`{{ref:${a.sourceKey}}}`).join(' '):'{{ref:a0}} 0-30秒说话。'}]};}})}});
 try{
  const bytes=Buffer.from('fake');await writeFile(store.media(p.id,'a.png'),bytes);
  p.assets=Array.from({length:10},(_,i)=>({id:`a${i}`,sourceKey:`a${i}`,kind:i?'prop':'character',name:`素材${i}`,selected:true,image:{file:'a.png',filename:'a.png',sha256:digest(bytes)}}));
  await workflow.generateStoryboards(p);
  assert.match(calls[0].instructions,/【调色基调\/Color】/);assert.match(calls[0].instructions,/每条引用1～9张/);assert.match(calls[0].instructions,/【时长】30秒/);
  await workflow.rebuildShot(p.id,p.shots[0].id,{duration:30});await workflow.active.get(`rebuild:${p.id}:${p.shots[0].id}`);
  assert.match(calls[1].instructions,/六个通道/);assert.match(calls[1].instructions,/每条1～9张/);
  assert.equal(JSON.parse(calls[1].input).consistencyAnchors.length,1);
  tooMany=true;const old=p.shots[0];await workflow.rebuildShot(p.id,old.id,{duration:30});await workflow.active.get(`rebuild:${p.id}:${old.id}`);
  assert.equal(p.shots[0],old);assert.equal(old.rebuildJob.state,'failed');
 }finally{workflow.stopping=true;await Promise.allSettled([...workflow.active.values()]);await rm(root,{recursive:true,force:true});}
});
