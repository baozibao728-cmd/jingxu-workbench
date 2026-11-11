import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskPool, ConcurrencySettings } from '../src/concurrency.js';
import { Workflow } from '../src/workflow.js';
import { ProjectStore } from '../src/project-store.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const until = async fn => { const end = Date.now()+3000; while(!fn()) { if(Date.now()>end)throw Error('等待并发测试状态超时'); await new Promise(resolve=>setImmediate(resolve)); } };

test('并发上限独立持久化为10，拒绝0、51和小数，保存失败不改变已有值', async () => {
  const root=await mkdtemp(join(tmpdir(),'drama-concurrency-'));
  try {
    const settings=new ConcurrencySettings(join(root,'concurrency.json'));await settings.init();
    assert.deepEqual(settings.value,{images:10,videos:10});
    await settings.save({images:50,videos:1});
    const reloaded=new ConcurrencySettings(settings.path);await reloaded.init();
    assert.deepEqual(reloaded.value,{images:50,videos:1});
    for(const images of [0,51,1.5,'10'])await assert.rejects(settings.save({images}),/1～50/);
    assert.deepEqual(settings.value,{images:50,videos:1});
  }finally{await rm(root,{recursive:true,force:true});}
});

test('队列动态提高上限立即填空位，降低不打断在途任务，失败释放槽位', async () => {
  const pool=new TaskPool(2), gates=Array.from({length:8},deferred), started=[];
  const jobs=gates.map((gate,index)=>pool.run(async()=>{started.push(index);await gate.promise;if(index===0)throw Error('模拟失败');return index;}));
  const results=Promise.allSettled(jobs);
  await until(()=>started.length===2);pool.setLimit(4);await until(()=>started.length===4);
  pool.setLimit(1);gates[0].resolve();gates[1].resolve();gates[2].resolve();
  await until(()=>pool.running===1);assert.equal(started.length,4);
  gates[3].resolve();await until(()=>started.length===5);
  pool.setLimit(50);await until(()=>started.length===8);gates.forEach(g=>g.resolve());
  const done=await results;assert.equal(done[0].status,'rejected');assert.equal(done.filter(x=>x.status==='fulfilled').length,7);
  await until(()=>pool.running===0);assert.equal(pool.waiting.length,0);
});

test('实际工作流图片和视频默认各10并发，调到1或50生效，全部任务完成且只提交一次',async()=>{
  const root=await mkdtemp(join(tmpdir(),'drama-pools-'));
  const store=new ProjectStore(root);await store.init();
  const config={deepseek:{apiKey:'fake'},grsai:{apiKey:'fake',model:'gpt-image-2'},fydmai:{apiKey:'fake',model:'c7-wan3',baseUrl:'https://video.example'}};
  let images=0,videos=0;const imageGates=Array.from({length:14},deferred),videoGates=Array.from({length:14},deferred);
  const workflow=new Workflow(store,()=>config,{
    intervalMs:1,
    factories:{image:()=>({submit:async()=>{const index=images++;await imageGates[index].promise;return{id:`image-${index}`,status:'completed',urls:['https://image.example/result']};}}),
      video:()=>({uploadImage:async()=>({assetId:'ref'}),submit:async()=>{const index=videos++;await videoGates[index].promise;return{id:`video-${index}`,status:'completed',urls:['https://video.example/result']};}})},
    download:async(url,path)=>writeFile(path,Buffer.from(url)),
  });
  const p=await store.create({script:'模拟剧本'});
  p.assets=Array.from({length:14},(_,i)=>({id:`a-${i}`,name:`素材${i}`,kind:'prop',prompt:'One prop',aspectRatio:'1:1',selected:true,job:{state:'idle'},history:[]}));
  workflow.generateStoryboards=async project=>{project.shots=Array.from({length:14},(_,i)=>({id:`s-${i}`,title:`分镜${i}`,duration:15,promptTemplate:'{{ref:a-0}} 静置。',assetIds:['a-0'],job:{state:'idle'},history:[]}));};
  try {
    assert.equal(workflow.concurrency().images.limit,10);assert.equal(workflow.concurrency().videos.limit,10);
    await workflow.startAssetGeneration(p.id,p.assets.map(a=>a.id));await until(()=>images===10);
    assert.equal(workflow.concurrency().images.queued,4);
    workflow.setConcurrency({images:1});imageGates.slice(0,10).forEach(g=>g.resolve());
    await until(()=>images===11);assert.equal(workflow.imagePool.running,1);
    workflow.setConcurrency({images:50});await until(()=>images===14);imageGates.forEach(g=>g.resolve());
    await workflow.active.get(`prepare:${p.id}`);assert.equal(p.assets.filter(a=>a.image).length,14);
    const ids=p.shots.map(s=>s.id),review=workflow.review(p.id,ids);
    await workflow.startVideos(p.id,ids,review.hash);await until(()=>videos===10);
    assert.equal(workflow.videoPool.waiting.length,4);
    workflow.setConcurrency({videos:1});videoGates.slice(0,10).forEach(g=>g.resolve());
    await until(()=>videos===11);assert.equal(workflow.videoPool.running,1);
    workflow.setConcurrency({videos:50});await until(()=>videos===14);videoGates.forEach(g=>g.resolve());
    await Promise.allSettled([...workflow.active.values()]);
    assert.equal(p.shots.filter(s=>s.video).length,14);assert.equal(images,14);assert.equal(videos,14);
  }finally{
    imageGates.forEach(g=>g.resolve());videoGates.forEach(g=>g.resolve());workflow.stopping=true;
    await Promise.allSettled([...workflow.active.values()]);await rm(root,{recursive:true,force:true});
  }
});
