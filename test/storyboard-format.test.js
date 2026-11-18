import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {resolvePrompts,renderStoryboardFormat,promptDefinitions} from '../src/prompt-settings.js';
import {Workflow} from '../src/workflow.js';import {ProjectStore,digest} from '../src/project-store.js';
import {detectPromptDuration,videoProfile} from '../src/video-profile.js';

test('不内置任何提示词规则；自己填的分镜模板按时长和画幅替换占位符，素材引用原样保留',()=>{
 const defaults=resolvePrompts();assert.deepEqual(Object.values(defaults),Array(promptDefinitions.length).fill(''));
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

test('拆解剧本同步列出分镜草稿（不立即出提示词）；资产生图与勾选生成分镜提示词可并发进行，手填提示词自动识别时间戳秒数',async()=>{
 const root=await mkdtemp(join(tmpdir(),'drama-concurrent-'));const store=new ProjectStore(root);await store.init();
 const p=await store.create({script:'场景一：专柜展示冲锋衣与赠品背包。',clipDuration:15,aspectRatio:'9:16'});
 const config=()=>({deepseek:{apiKey:'fake'},grsai:{apiKey:'fake',model:'gpt-image-2'},fydmai:{apiKey:'fake',model:'c7-wan3',baseUrl:'https://video.example'}});
 let releaseImage,imgSeq=0;const imageGate=new Promise(r=>{releaseImage=r;});
 const submittedVideos=[];
 const workflow=new Workflow(store,config,{
  intervalMs:1,
  factories:{
   text:()=>({generateJson:async req=>{
    const data=JSON.parse(req.input);
    if(data.chunk){
     return {
      assets:[
       {key:'host_a',kind:'character',name:'人物一',description:'女主播',prompt:'Woman in jacket'},
       {key:'bag',kind:'prop',name:'赠品户外大背包',description:'背包',prompt:'Backpack on white'}
      ],
      shots:[
       {title:'镜头一：开场送包',description:'人物一展示户外大背包',duration:15,assetKeys:['host_a','bag']},
       {title:'镜头二：面料展示',description:'人物一拉开拉链展示加绒内里',duration:15,assetKeys:['host_a']}
      ]
     };
    }
    return {shots:[{title:data.currentShot.title,description:data.currentShot.description,duration:22,promptTemplate:'{{ref:host_a}} {{ref:bag}} [0s-5.1s] 拿起背包展示 [5.1s-22.0s] 讲解卖点。'}]};
   }}),
   image:()=>({submit:async()=>{await imageGate;const n=++imgSeq;return {id:`img-${n}`,status:'completed',urls:[`https://image.example/${n}.png`]};}}),
   video:()=>({uploadImage:async()=>({assetId:'up-1'}),submit:async req=>{submittedVideos.push(req);return {id:`vid-${submittedVideos.length}`,status:'completed',urls:['https://video.example/1.mp4']};}}),
  },
  download:async(url,path)=>writeFile(path,String(url)),
 });
 try{
  await workflow.startPreparation(p.id);await workflow.active.get(`prepare:${p.id}`);
  assert.equal(p.assets.length,2);
  assert.equal(p.shots.length,2);
  assert.equal(p.shots[0].promptTemplate,'');
  assert.equal(p.shots[1].promptTemplate,'');
  assert.equal(p.chunks[0].storyboardState,'outlined');
  // 启动资产生图（挂起在 imageGate），同时不等待图片完成就并发为第1条分镜生成提示词、为第2条分镜手动填入带时间戳的提示词
  await workflow.startAssetGeneration(p.id,p.assets.map(a=>a.id));
  assert.equal(p.preparation.state,'running');
  assert.ok(p.assets.every(a=>!a.image));
  await workflow.generateShotPrompts(p.id,[p.shots[0].id]);
  await workflow.active.get(`shot-prompts:${p.id}`);
  assert.match(p.shots[0].promptTemplate,/\{\{ref:/);
  assert.equal(p.shots[0].duration,22);
  assert.equal(p.shots[1].promptTemplate,'');
  // 第2条分镜由用户手动粘贴提示词（含 @ 空格引用与多段时间戳，自动识别为 28 秒）
  const manualPrompt=`【参考对应】\n@ 人物一\n@ 赠品户外大背包\n[0s-7.0s] 人物一展示冲锋衣外观。\n[7.0s-27.8s] 人物一拉开拉链展示加绒内里并号召下单。`;
  await workflow.editShot(p.id,p.shots[1].id,{prompt:manualPrompt});
  assert.equal(p.shots[1].duration,28);
  assert.equal(p.chunks[0].storyboardState,'completed');
  // 此时资产图完成，不会覆盖已生成和手填的分镜提示词
  releaseImage();
  await workflow.active.get(`prepare:${p.id}`);
  assert.ok(p.assets.every(a=>a.image));
  assert.equal(p.shots[0].duration,22);
  assert.equal(p.shots[1].duration,28);
  // 提交视频时按各分镜自己的秒数（22秒、28秒）提交
  const ids=p.shots.map(s=>s.id),review=workflow.review(p.id,ids);
  assert.equal(review.totalSeconds,50);
  await workflow.startVideos(p.id,ids,review.hash);
  await Promise.allSettled([...workflow.active.values()]);
  assert.deepEqual(submittedVideos.map(v=>v.duration).sort((a,b)=>a-b),[22,28]);
 }finally{releaseImage?.();workflow.stopping=true;await Promise.allSettled([...workflow.active.values()]);await rm(root,{recursive:true,force:true});}
});

test('时间戳时长识别支持预计总时长、全程秒数、中括号时间段与分秒格式',()=>{
 const profile=videoProfile('c7-wan3');
 assert.equal(detectPromptDuration('【预计总时长】30秒\n[0s-5.1s] 开场 [27.1s-30.0s] 收尾',profile),30);
 assert.equal(detectPromptDuration('全程28秒，00-07秒进场，07-28秒口播',profile),28);
 assert.equal(detectPromptDuration('[0.0s—3.6s] 动作一 [3.6s—19.2s] 动作二',profile),20);
 assert.equal(detectPromptDuration('纯文字没有时间戳',profile),null);
});

test('资产支持按人物/道具/场景修改分类，重新生成多张（抽卡）一次性并发提交并可自由切换候选图',async()=>{
 const root=await mkdtemp(join(tmpdir(),'drama-draw-'));const store=new ProjectStore(root);await store.init();
 const p=await store.create({script:'场景一：抽卡测试'});
 p.assets=[{id:'a1',sourceKey:'a1',name:'测试道具',kind:'scene',prompt:'A sword',aspectRatio:'16:9',selected:true,history:[],job:{state:'idle'}}];
 let seq=0;
 const config=()=>({deepseek:{apiKey:'fake'},grsai:{apiKey:'fake',model:'gpt-image-2'},fydmai:{apiKey:'fake',model:'c7-wan3',baseUrl:'https://video.example'}});
 const workflow=new Workflow(store,config,{
  intervalMs:1,
  factories:{
   image:()=>({submit:async()=>{const n=++seq;return {id:`task-${n}`,status:'completed',urls:[`https://image.example/card-${n}.png`]};}}),
  },
  download:async(url,path)=>writeFile(path,String(url)),
 });
 try{
  await workflow.editAsset(p.id,'a1',{kind:'prop'});
  assert.equal(p.assets[0].kind,'prop');
  assert.equal(p.assets[0].aspectRatio,'1:1');
  await workflow.regenerateAsset(p.id,'a1',{count:4});
  await workflow.active.get(`asset:${p.id}:a1`);
  assert.equal(seq,4);
  assert.equal(p.assets[0].job.state,'completed');
  assert.equal(p.assets[0].job.batchCompleted,4);
  assert.ok(p.assets[0].image?.file);
  assert.equal(p.assets[0].history.length,3);
  const view=workflow.view(p);
  assert.ok(view.assets[0].history.every(item=>item.url?.startsWith(`/media/${p.id}/`)));
  const candidateFile=p.assets[0].history[1].file;
  const previousActive=p.assets[0].image.file;
  await workflow.selectAssetImage(p.id,'a1',candidateFile);
  assert.equal(p.assets[0].image.file,candidateFile);
  assert.ok(p.assets[0].history.some(item=>item.file===previousActive));
 }finally{workflow.stopping=true;await Promise.allSettled([...workflow.active.values()]);await rm(root,{recursive:true,force:true});}
});

test('角色多穿搭/场景变体自动绑定第一张基础图并在生成与抽卡时附带参考图',async()=>{
 const root=await mkdtemp(join(tmpdir(),'drama-ref-'));const store=new ProjectStore(root);await store.init();
 const p=await store.create({script:'场一：沈姨在家，随后换礼服出场。',clipDuration:15,aspectRatio:'9:16'});
 const config=()=>({deepseek:{apiKey:'fake'},grsai:{apiKey:'fake',model:'gpt-image-2'},fydmai:{apiKey:'fake',model:'c7-wan3',baseUrl:'https://video.example'}});
 const submissions=[];let seq=0;
 const workflow=new Workflow(store,config,{
  intervalMs:1,
  factories:{
   text:()=>({generateJson:async()=>({
    assets:[
     {key:'shen_base',kind:'character',name:'R1人物·沈姨',description:'基础日常穿搭',prompt:'Middle-aged Chinese woman in daily home clothes'},
     {key:'shen_look2',kind:'character',name:'R1人物·沈姨·造型二',referenceKey:'shen_base',description:'礼服穿搭',prompt:'Same woman wearing navy evening dress'},
     {key:'shen_look3',kind:'character',name:'R1人物·沈姨·造型三',description:'工装穿搭',prompt:'Same woman wearing work apron'}
    ],
    shots:[{title:'镜头一',description:'沈姨出场',duration:15,assetKeys:['shen_base']}]
   })}),
   image:()=>({submit:async req=>{
    const n=++seq;submissions.push(req);
    return {id:`img-${n}`,status:'completed',urls:[`https://image.example/${n}.png`]};
   }}),
  },
  download:async(url,path)=>writeFile(path,Buffer.from(`fake-png-${url}`)),
 });
 try{
  await workflow.startPreparation(p.id);await workflow.active.get(`prepare:${p.id}`);
  assert.equal(p.assets.length,3);
  const [base,look2,look3]=p.assets;
  assert.equal(base.referenceAssetId,undefined);
  assert.equal(look2.referenceAssetId,base.id);
  assert.equal(look3.referenceAssetId,base.id);
  // 若直接重做造型二但第一张还没出图，应提示先生成第一张
  await workflow.regenerateAsset(p.id,look2.id,{count:2});
  await workflow.active.get(`asset:${p.id}:${look2.id}`);
  assert.equal(look2.job.state,'failed');
  assert.match(look2.job.error,/请先生成基础参考图/);
  // 一键全部生成：先波次1生成 base，再波次2自动带 base 图生成 look2 与 look3
  await workflow.startAssetGeneration(p.id,p.assets.map(a=>a.id));
  await workflow.active.get(`prepare:${p.id}`);
  assert.ok(base.image && look2.image && look3.image);
  assert.equal(submissions.length,3);
  assert.equal(submissions[0].images.length,0);
  assert.equal(submissions[1].images.length,1);
  assert.equal(submissions[2].images.length,1);
  assert.match(submissions[1].images[0],/^data:image\/png;base64,/);
  assert.match(submissions[1].prompt,/同角色换装\/追加造型参考图锁定/);
  // 对造型二进行 2 张抽卡，也自动带上第一张基础图
  const before=submissions.length;
  await workflow.regenerateAsset(p.id,look2.id,{count:2});
  await workflow.active.get(`asset:${p.id}:${look2.id}`);
  assert.equal(submissions.length,before+2);
  assert.equal(submissions[before].images.length,1);
  assert.equal(submissions[before+1].images.length,1);
  // 编辑参考图：校验防环并支持清空
  await assert.rejects(()=>workflow.editAsset(p.id,base.id,{referenceAssetId:look2.id}),/互相设为参考图/);
  await workflow.editAsset(p.id,look3.id,{referenceAssetId:''});
  assert.equal(look3.referenceAssetId,undefined);
 }finally{workflow.stopping=true;await Promise.allSettled([...workflow.active.values()]);await rm(root,{recursive:true,force:true});}
});
