import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProjectStore} from '../src/project-store.js';
import {Workflow} from '../src/workflow.js';

async function fixture({count=3,onImage,onVideo,available=true}={}){
  const root=await mkdtemp(join(tmpdir(),'drama-auto-'));
  const store=new ProjectStore(root);await store.init();
  const project=await store.create({script:Array.from({length:count},(_,i)=>`场景${i+1}：房间\n人物拿起信。`).join('\n')});
  let textCalls=0,imageCalls=0;const submissions=[];
  const config={deepseek:{apiKey:'fake',model:'text'},grsai:{apiKey:'fake',model:'gpt-image-fake'},fydmai:{apiKey:'fake',model:'c7-wan3',baseUrl:'https://video.example'}};
  const workflow=new Workflow(store,()=>config,{
    intervalMs:1,refreshCapabilities:async()=>({models:[{kind:'video',model:'c7-wan3',onShelf:available}]}),
    factories:{
      text:()=>({generateJson:async({input})=>{textCalls++;const data=JSON.parse(input);return data.chunk?{assets:[{key:'hero',name:'主角',kind:'character',prompt:'Adult person'}]}:{shots:[{title:data.chunkTitle,duration:15,promptTemplate:'{{ref:hero}} 拿起信。'}]};}}),
      image:()=>({submit:async()=>{imageCalls++;await onImage?.(project,workflow);return {id:'image-fake',status:'completed',urls:['https://image.example/result.png']};}}),
      video:()=>({uploadImage:async()=>({assetId:'asset-fake'}),submit:async request=>{
        // All chunks and shot rows must be persisted before the first video submission.
        const saved=JSON.parse(await readFile(store.directory(project.id)+'/project.json','utf8'));
        assert.equal(saved.shots.length,count);assert.equal(saved.preparation.state,'completed');
        assert.ok(saved.chunks.every(chunk=>chunk.storyboardState==='completed'));
        submissions.push(request);await onVideo?.(project,workflow);
        return {id:`video-${submissions.length}`,status:'completed',urls:['https://video.example/result.mp4']};
      }}),
    },download:async(url,path)=>{await writeFile(path,'fake-media');},
  });
  return {store,project,workflow,submissions,counts:()=>({textCalls,imageCalls}),
    settle:async()=>{while(workflow.active.size)await Promise.allSettled([...workflow.active.values()]);},
    cleanup:async()=>{workflow.stopping=true;await Promise.allSettled([...workflow.active.values()]);await rm(root,{recursive:true,force:true});}};
}

test('默认人工检查；打开开关并保存不生成，点击全自动后才贯通45镜，重复启动复用成品',async()=>{
  const f=await fixture({count:45});
  try{
    assert.equal(f.project.skipReview,false);
    await f.workflow.updateProject(f.project.id,{skipReview:true});
    assert.deepEqual(f.counts(),{textCalls:0,imageCalls:0});assert.equal(f.submissions.length,0);
    await f.workflow.startPreparation(f.project.id);await f.settle();
    assert.equal(f.project.shots.length,45);assert.equal(f.submissions.length,45);
    assert.equal(f.counts().imageCalls,1);
    assert.ok(f.project.shots.every(shot=>shot.video&&shot.job.approvalMode==='automatic'));
    const reloaded=new ProjectStore(f.store.root);await reloaded.init();
    assert.equal(reloaded.get(f.project.id).skipReview,true);
    await f.workflow.startPreparation(f.project.id);await f.settle();
    assert.equal(f.submissions.length,45);assert.equal(f.counts().imageCalls,1);
  }finally{await f.cleanup();}
});

test('全自动在图片生成中关闭后，不生成分镜或视频，手动续接仍停在视频确认',async()=>{
  const f=await fixture({onImage:async(project,workflow)=>{await workflow.updateProject(project.id,{skipReview:false});}});
  try{
    await f.workflow.updateProject(f.project.id,{skipReview:true});
    await f.workflow.startPreparation(f.project.id);await f.settle();
    assert.equal(f.counts().imageCalls,1);assert.equal(f.project.shots.length,0);assert.equal(f.submissions.length,0);
    await f.workflow.startAssetGeneration(f.project.id,f.project.assets.map(a=>a.id));await f.settle();
    assert.equal(f.project.shots.length,3);assert.equal(f.submissions.length,0);
    const ids=f.project.shots.map(shot=>shot.id),review=f.workflow.review(f.project.id,ids);
    await assert.rejects(f.workflow.startVideos(f.project.id,ids,review.hash,{automatic:true}),/全自动已关闭/);
  }finally{await f.cleanup();}
});

test('关闭开关阻止队列中尚未提交的视频，已完成视频保留',async()=>{
  const f=await fixture({onVideo:async(project,workflow)=>{await workflow.updateProject(project.id,{skipReview:false});}});
  try{
    f.workflow.setConcurrency({videos:1}); // Keep jobs queued while the first submitted task closes automation.
    await f.workflow.updateProject(f.project.id,{skipReview:true});
    await f.workflow.startPreparation(f.project.id);await f.settle();
    assert.equal(f.submissions.length,1);assert.ok(f.project.shots[0].video);
    assert.ok(f.project.shots.slice(1).every(shot=>!shot.job.taskId&&shot.job.state==='failed'));
  }finally{await f.cleanup();}
});

test('全自动在模型未上架时不发起文本、图片或视频调用',async()=>{
  const f=await fixture({available:false});
  try{
    await f.workflow.updateProject(f.project.id,{skipReview:true});
    await assert.rejects(f.workflow.startPreparation(f.project.id),/未上架/);
    assert.deepEqual(f.counts(),{textCalls:0,imageCalls:0});assert.equal(f.submissions.length,0);
    await assert.rejects(f.workflow.updateProject(f.project.id,{skipReview:'true'}),/开关值/);
  }finally{await f.cleanup();}
});

test('已有提交结果未知的视频在全自动下仍然要求先核对，不能重提',async()=>{
  const f=await fixture({count:1});
  try{
    await f.workflow.startPreparation(f.project.id);await f.settle();
    await f.workflow.startAssetGeneration(f.project.id,f.project.assets.map(a=>a.id));await f.settle();
    const shot=f.project.shots[0];shot.job={state:'unknown'};
    await f.workflow.updateProject(f.project.id,{skipReview:true});
    await f.workflow.startPreparation(f.project.id);await f.settle();
    assert.equal(f.project.preparation.state,'failed');
    assert.match(f.project.preparation.error,/结果未知/);assert.equal(f.submissions.length,0);
  }finally{await f.cleanup();}
});
