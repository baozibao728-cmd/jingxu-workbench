import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Workflow} from '../src/workflow.js';import {ProjectStore,digest} from '../src/project-store.js';
const config=()=>({deepseek:{apiKey:'fake',model:'fake-text'},grsai:{apiKey:'fake',model:'gpt-image-2'},fydmai:{apiKey:'fake',baseUrl:'https://video.example',model:'c7-wan3'}});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'drama-shot-rebuild-')),store=new ProjectStore(root);await store.init();
 const project=await store.create({script:'场景一：主角拿起信，然后望窗。'});const bytes=Buffer.from('fake');await writeFile(store.media(project.id,'hero.png'),bytes);
 project.assets=[{id:'hero-id',sourceKey:'hero',name:'主角',kind:'character',image:{file:'hero.png',filename:'hero.png',sha256:digest(bytes)},job:{state:'completed'}}];
 project.chunks=[{id:'scene-1',index:1,text:project.script,analysisState:'completed',storyboardState:'completed'}];
 project.shots=[{id:'s1',title:'取信',duration:15,promptTemplate:'{{ref:hero-id}} 拿起信。',assetIds:['hero-id'],chunkId:'scene-1',job:{state:'idle'},history:[]},{id:'s2',title:'望窗',duration:15,promptTemplate:'{{ref:hero-id}} 望向窗外。',assetIds:['hero-id'],chunkId:'scene-1',job:{state:'idle'},history:[]}];
 let submissions=0;const calls=[];
 const options={factories:{text:()=>({generateJson:async request=>{calls.push(request);return{boundaryConfirmation:JSON.parse(request.input).locked,shots:[{title:'动作前半',duration:30,promptTemplate:'{{ref:hero}} 0-30秒拿起信。'},{title:'动作后半',duration:30,promptTemplate:'{{ref:hero}} 0-30秒看信。'}]};}}),video:()=>({submit:async()=>{submissions++;throw Error('不能调用生成');},uploadImage:async()=>({assetId:'remote-hero'}),getTask:async id=>({id,status:'completed',urls:['https://video.example/result.mp4']})})},download:async(url,path)=>writeFile(path,'fake-video'),intervalMs:1};
 const workflow=new Workflow(store,config,options);
 return{root,store,project,workflow,options,calls,submissions:()=>submissions,cleanup:async()=>{workflow.stopping=true;await Promise.allSettled([...workflow.active.values()]);await rm(root,{recursive:true,force:true});}};
}

test('当前分镜可按30秒AI重新拆成多条，只替换当前条，保留旧片与其他分镜且不生成视频',async()=>{
 const f=await fixture();try{
 const old=f.project.shots[0];old.video={file:'old.mp4',inputHash:f.workflow.inputHash(f.project,old),duration:15};const neighbor=f.project.shots[1];
 await f.workflow.rebuildShot(f.project.id,'s1',{duration:30,prompt:'@主角 拿起信。',notes:'拆成两个动作，慢一些'});await f.workflow.active.get(`rebuild:${f.project.id}:s1`);
 assert.equal(f.project.shots.length,3);assert.equal(f.project.shots[0].id,'s1');assert.equal(f.project.shots[0].duration,30);assert.equal(f.project.shots[1].duration,30);assert.equal(f.project.shots[2],neighbor);
 assert.equal(f.project.shots[0].video.file,'old.mp4');assert.equal(f.workflow.view(f.project).shots[0].stale,true);
 assert.equal(f.project.storyboardHistory[0].original.promptTemplate,old.promptTemplate);
 assert.equal(JSON.parse(f.calls[0].input).notes,'拆成两个动作，慢一些');assert.match(f.calls[0].instructions,/固定30秒/);
 assert.equal(f.submissions(),0);
 const review=f.workflow.review(f.project.id,f.project.shots.slice(0,2).map(s=>s.id));assert.equal(review.totalSeconds,60);
 }finally{await f.cleanup();}
});

test('AI重拆失败或素材非法保留原镜，等待期间禁止提交和修改',async()=>{
 const f=await fixture();try{
 let release;const waiting=new Promise(r=>release=r);
 f.workflow.factories.text=()=>({generateJson:async request=>{await waiting;return{boundaryConfirmation:JSON.parse(request.input).locked,shots:[{title:'坏引用',duration:30,promptTemplate:'{{ref:missing}} 走路。'}]};}});
 const old=f.project.shots[0],oldPrompt=old.promptTemplate;
 await f.workflow.rebuildShot(f.project.id,'s1',{duration:30});
 assert.throws(()=>f.workflow.review(f.project.id,['s1']),/处理中/);
 await assert.rejects(f.workflow.editShot(f.project.id,'s1',{duration:30}),/正在处理/);
 release();await f.workflow.active.get(`rebuild:${f.project.id}:s1`);
 assert.equal(f.project.shots[0],old);assert.equal(old.promptTemplate,oldPrompt);assert.equal(old.duration,15);assert.equal(old.rebuildJob.state,'failed');assert.equal(f.submissions(),0);
 }finally{await f.cleanup();}
});

test('修改单条15→30秒会使旧确认失效，整剧默认时长不改动已有条目',async()=>{
 const f=await fixture();try{
 const before=f.workflow.review(f.project.id,['s1']);await f.workflow.editShot(f.project.id,'s1',{duration:30});
 await assert.rejects(f.workflow.startVideos(f.project.id,['s1'],before.hash),/重新查看/);
 assert.equal(f.project.shots[1].duration,15);assert.equal(f.workflow.review(f.project.id,['s1']).totalSeconds,30);
 }finally{await f.cleanup();}
});

test('隔天启动：有编号但下载失败的视频自动只查原任务并下载，本机未提交项不自动重提',async()=>{
 const f=await fixture();try{
 const shot=f.project.shots[0],snapshot=f.workflow.review(f.project.id,['s1']).shots[0];
 shot.job={state:'failed',taskId:'paid-yesterday',operationId:'original-operation',snapshot,error:'模拟网络中断'};
 const unsent=f.project.shots[1];unsent.job={state:'pending',snapshot:f.workflow.review(f.project.id,['s2']).shots[0]};
 await f.store.save(f.project);
 const reloaded=new ProjectStore(f.root);await reloaded.init();let queries=[];
 const videoFactory=()=>({...f.options.factories.video(),getTask:async id=>{queries.push(id);return{id,status:'completed',urls:['https://video.example/result.mp4']};}});
 const resumed=new Workflow(reloaded,config,{...f.options,factories:{...f.options.factories,video:videoFactory}});
 await resumed.recover();await Promise.allSettled([...resumed.active.values()]);
 assert.deepEqual(queries,['paid-yesterday']);assert.equal(f.submissions(),0);
 const saved=reloaded.get(f.project.id);assert.equal(saved.shots[0].job.state,'completed');assert.equal(saved.shots[1].job.state,'failed');
 assert.equal((await readFile(reloaded.media(saved.id,saved.shots[0].video.file),'utf8')),'fake-video');resumed.stopping=true;
 }finally{await f.cleanup();}
});

test('重拆标记全部后续分镜待对齐并拦截提交，确认后解除；分镜编号重新连续排列',async()=>{
 const f=await fixture();try{f.project.shots[1].promptTemplate='{分镜2}\n{{ref:hero-id}} 望向窗外。';await f.workflow.rebuildShot(f.project.id,'s1',{duration:30});await f.workflow.active.get(`rebuild:${f.project.id}:s1`);const downstream=f.project.shots[2];assert.equal(downstream.continuityReview.state,'required');assert.match(downstream.promptTemplate,/\{分镜3\}/);assert.throws(()=>f.workflow.review(f.project.id,[downstream.id]),/对齐/);await f.workflow.acceptContinuity(f.project.id,downstream.id);assert.equal(f.workflow.review(f.project.id,[downstream.id]).totalSeconds,15);assert.equal(f.submissions(),0);}finally{await f.cleanup();}
});

test('顺序AI对齐承接最新上一镜、保留原终点和台词；全部成功才落盘，失败保持原镜与旧成片',async()=>{
 const f=await fixture();try{
  f.project.shots.push({...structuredClone(f.project.shots[1]),id:'s3',title:'离开',promptTemplate:'{{ref:hero-id}} 主角：“我走了。”'});
  f.project.shots[1].video={file:'old-next.mp4',duration:15};
  await f.workflow.editShot(f.project.id,'s1',{prompt:'@主角 拿起信，面向窗外。'});
  const original=structuredClone(f.project.shots),calls=[];let failLast=true;
  f.workflow.factories.text=()=>({generateJson:async req=>{const input=JSON.parse(req.input);calls.push(input);if(input.segmentNumber===3&&failLast)throw Error('模拟第三镜失败');return{duration:15,boundaryConfirmation:input.locked,promptTemplate:`{分镜${input.segmentNumber}}\n{{ref:hero}} 本段起始状态：接上镜。\n`+(input.segmentNumber===3?'主角：“我走了。”':'望向窗外，放下信。')};}});
  await f.workflow.alignFollowing(f.project.id);await f.workflow.active.get(`align:${f.project.id}`);assert.deepEqual(f.project.shots,original);assert.equal(f.project.preparation.state,'failed');
  failLast=false;calls.length=0;await f.workflow.alignFollowing(f.project.id);await f.workflow.active.get(`align:${f.project.id}`);assert.equal(f.project.preparation.state,'completed');assert.equal(f.project.shots[1].continuityReview.state,'aligned');assert.equal(f.project.shots[2].continuityReview.state,'aligned');assert.equal(calls[1].locked.start,f.project.shots[1].continuity.end);assert.equal(f.project.shots[1].video.file,'old-next.mp4');assert.equal(f.project.storyboardHistory.at(-1).originals[1].promptTemplate,original[1].promptTemplate);assert.doesNotThrow(()=>f.workflow.review(f.project.id,['s2','s3']));assert.equal(f.submissions(),0);
 }finally{await f.cleanup();}
});

test('AI重拆改变原句台词或拒绝锁定边界，原分镜及后续保持原样',async()=>{
 const f=await fixture();try{f.project.shots[0].promptTemplate='{{ref:hero-id}} 主角：“不能改这句。”';const original=structuredClone(f.project.shots);for(const badBoundary of [true,false]){
 f.workflow.factories.text=()=>({generateJson:async req=>({boundaryConfirmation:badBoundary?{}:JSON.parse(req.input).locked,shots:[{duration:15,promptTemplate:'{{ref:hero}} 主角：“改了原句。”'}]})});await f.workflow.rebuildShot(f.project.id,'s1');await f.workflow.active.get(`rebuild:${f.project.id}:s1`);assert.equal(f.project.shots[0].promptTemplate,original[0].promptTemplate);assert.equal(f.project.shots[0].rebuildJob.state,'failed');assert.equal(f.project.shots[1].continuityReview,undefined);
 }}finally{await f.cleanup();}
});

test('升级绑定历史厂商连接，未改内容的旧成片仍有效；切换后有编号任务用原连接查询',async()=>{
 const f=await fixture();try{const configNow=config();configNow.grsai.id='image-original';configNow.fydmai.id='video-original';f.workflow.getConfig=()=>configNow;const shot=f.project.shots[0];const legacy=digest({prompt:shot.promptTemplate,duration:shot.duration,aspectRatio:f.project.aspectRatio,model:configNow.fydmai.model,resolution:f.workflow.resolution(f.project),assets:shot.assetIds.map(id=>({id,version:f.project.assets.find(a=>a.id===id).image.sha256}))});shot.video={file:'old.mp4',model:'c7-wan3',duration:15,inputHash:legacy};shot.job.snapshot={model:'c7-wan3',inputHash:legacy};assert.equal(f.workflow.migrateProviderBindings(f.project),true);assert.equal(shot.video.legacyInputHash,legacy);assert.equal(f.workflow.view(f.project).shots[0].stale,false);assert.equal(shot.job.snapshot.providerId,'video-original');const original={...configNow.fydmai};f.workflow.getProviderById=id=>{assert.equal(id,'video-original');return original;};configNow.fydmai={...original,id:'video-new',baseUrl:'https://another.example'};assert.equal(f.workflow.videoConfig(shot.job.snapshot).baseUrl,'https://video.example');assert.equal(f.workflow.view(f.project).shots[0].stale,true);}finally{await f.cleanup();}
});
