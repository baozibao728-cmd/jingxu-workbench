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
 const options={factories:{text:()=>({generateJson:async request=>{calls.push(request);return{shots:[{title:'优化后的取信',duration:30,promptTemplate:'{{ref:hero}} 0-30秒稳定拿起信。'}]};}}),video:()=>({submit:async()=>{submissions++;throw Error('不能调用生成');},uploadImage:async()=>({assetId:'remote-hero'}),getTask:async id=>({id,status:'completed',urls:['https://video.example/result.mp4']})})},download:async(url,path)=>writeFile(path,'fake-video'),intervalMs:1};
 const workflow=new Workflow(store,config,options);
 return{root,store,project,workflow,options,calls,submissions:()=>submissions,cleanup:async()=>{workflow.stopping=true;await Promise.allSettled([...workflow.active.values()]);await rm(root,{recursive:true,force:true});}};
}

test('当前分镜只由AI更新提示词，保留旧片与其他分镜且不生成视频',async()=>{
 const f=await fixture();try{
 const old=f.project.shots[0];const oldPrompt=old.promptTemplate;old.video={file:'old.mp4',inputHash:f.workflow.inputHash(f.project,old),duration:15};const neighbor=f.project.shots[1];
 await f.workflow.rebuildShot(f.project.id,'s1',{duration:30,prompt:'@主角 拿起信。',notes:'拆成两个动作，慢一些'});await f.workflow.active.get(`rebuild:${f.project.id}:s1`);
 assert.equal(f.project.shots.length,2);assert.equal(f.project.shots[0].id,'s1');assert.equal(f.project.shots[0].duration,30);assert.equal(f.project.shots[0].title,'优化后的取信');assert.equal(f.project.shots[1],neighbor);
 assert.equal(f.project.shots[0].video.file,'old.mp4');assert.equal(f.workflow.view(f.project).shots[0].stale,true);
 assert.equal(f.project.storyboardHistory[0].original.promptTemplate,oldPrompt);
 assert.equal(JSON.parse(f.calls[0].input).notes,'拆成两个动作，慢一些');assert.match(f.calls[0].instructions,/只输出一个shots元素/);assert.doesNotMatch(f.calls[0].instructions,/前后接缝/);
 assert.equal(f.submissions(),0);
 const review=f.workflow.review(f.project.id,['s1']);assert.equal(review.totalSeconds,30);
 }finally{await f.cleanup();}
});

test('AI重拆失败或素材非法保留原镜，等待期间禁止提交和修改',async()=>{
 const f=await fixture();try{
 let release;const waiting=new Promise(r=>release=r);
 f.workflow.factories.text=()=>({generateJson:async request=>{await waiting;return{shots:[{title:'坏引用',duration:30,promptTemplate:'{{ref:missing}} 走路。'}]};}});
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

test('单镜提示词重做不标记后续分镜，也不要求衔接确认',async()=>{
 const f=await fixture();try{await f.workflow.rebuildShot(f.project.id,'s1',{duration:30});await f.workflow.active.get(`rebuild:${f.project.id}:s1`);const downstream=f.project.shots[1];assert.equal(downstream.continuityReview,undefined);assert.equal(f.workflow.review(f.project.id,[downstream.id]).totalSeconds,15);assert.equal(f.submissions(),0);}finally{await f.cleanup();}
});

test('旧一键对齐已停用，提示改用全部重解析，不调用模型或更改分镜',async()=>{const f=await fixture();try{const original=structuredClone(f.project.shots);await assert.rejects(f.workflow.alignFollowing(f.project.id),error=>error.status===410&&/全部重新解析分镜/.test(error.message));assert.deepEqual(f.project.shots,original);assert.equal(f.calls.length,0);assert.equal(f.submissions(),0);}finally{await f.cleanup();}});

test('AI重拆改变原句台词时保留原分镜',async()=>{
 const f=await fixture();try{f.project.shots[0].promptTemplate='{{ref:hero-id}} 主角：“不能改这句。”';const original=structuredClone(f.project.shots);
 f.workflow.factories.text=()=>({generateJson:async req=>({shots:[{duration:15,promptTemplate:'{{ref:hero}} 主角：“改了原句。”'}]})});await f.workflow.rebuildShot(f.project.id,'s1');await f.workflow.active.get(`rebuild:${f.project.id}:s1`);assert.equal(f.project.shots[0].promptTemplate,original[0].promptTemplate);assert.equal(f.project.shots[0].rebuildJob.state,'failed');assert.equal(f.project.shots[1].continuityReview,undefined);
 }finally{await f.cleanup();}
});

test('升级绑定历史厂商连接，未改内容的旧成片仍有效；切换后有编号任务用原连接查询',async()=>{
 const f=await fixture();try{const configNow=config();configNow.grsai.id='image-original';configNow.fydmai.id='video-original';f.workflow.getConfig=()=>configNow;const shot=f.project.shots[0];const legacy=digest({prompt:shot.promptTemplate,duration:shot.duration,aspectRatio:f.project.aspectRatio,model:configNow.fydmai.model,resolution:f.workflow.resolution(f.project),assets:shot.assetIds.map(id=>({id,version:f.project.assets.find(a=>a.id===id).image.sha256}))});shot.video={file:'old.mp4',model:'c7-wan3',duration:15,inputHash:legacy};shot.job.snapshot={model:'c7-wan3',inputHash:legacy};assert.equal(f.workflow.migrateProviderBindings(f.project),true);assert.equal(shot.video.legacyInputHash,legacy);assert.equal(f.workflow.view(f.project).shots[0].stale,false);assert.equal(shot.job.snapshot.providerId,'video-original');const original={...configNow.fydmai};f.workflow.getProviderById=id=>{assert.equal(id,'video-original');return original;};configNow.fydmai={...original,id:'video-new',baseUrl:'https://another.example'};assert.equal(f.workflow.videoConfig(shot.job.snapshot).baseUrl,'https://video.example');assert.equal(f.workflow.view(f.project).shots[0].stale,true);}finally{await f.cleanup();}
});
