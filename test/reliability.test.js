import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Workflow} from '../src/workflow.js';import {ProjectStore,digest} from '../src/project-store.js';import {splitScript} from '../src/script-chunks.js';
import {testProvider} from '../src/provider-test.js';

const config=()=>({deepseek:{apiKey:'fake-text',baseUrl:'https://text.example',model:'mock'},grsai:{apiKey:'fake-image',baseUrl:'https://image.example',model:'mock'},fydmai:{apiKey:'fake-video',baseUrl:'https://video.example',model:'c7-wan3'}});
async function fixture(script,reply){
 const root=await mkdtemp(join(tmpdir(),'jingxu-reliability-')),store=new ProjectStore(root);await store.init();const project=await store.create({script});
 const bytes=Buffer.from('fake-image');await writeFile(store.media(project.id,'hero.png'),bytes);
 project.assets=[{id:'hero-id',sourceKey:'hero',name:'主角',kind:'character',selected:true,description:'同一造型',history:[],job:{state:'completed'},image:{file:'hero.png',sha256:digest(bytes),filename:'hero.png'}}];
 project.chunks=splitScript(project.script);project.chunks.forEach(c=>{c.analysisState='completed';c.storyboardState='completed';c.assetIds=['hero-id'];});
 project.shots=[{id:'old',title:'旧分镜',duration:15,promptTemplate:'{{ref:hero-id}} 旧内容',assetIds:['hero-id'],history:[],job:{state:'idle'}}];await store.save(project);
 const calls=[];let images=0;
 const factories={text:()=>({generateJson:async req=>{const input=JSON.parse(req.input);calls.push(input);return reply(input,calls.length);}}),image:()=>({submit:async()=>{images++;throw Error('不得生图');}}),video:()=>({submit:async()=>{throw Error('不得生视频');}})};
 const workflow=new Workflow(store,config,{factories});
 return{store,project,workflow,calls,images:()=>images,settle:()=>workflow.active.get(`reparse:${project.id}`),cleanup:async()=>{workflow.stopping=true;await Promise.allSettled([...workflow.active.values()]);await rm(root,{recursive:true,force:true});}};
}
const shot=(input,ref='hero')=>({shots:[{title:'新分镜',duration:30,promptTemplate:`{{ref:${ref}}} ${input.script}`}]});

test('输出被截断时自动把该段对半拆开继续解析，原文不丢，整轮不中断',async()=>{
 const script=`场景一：房间\n${'主角：“这一句台词保持不变。”\n'.repeat(60)}`;
 const f=await fixture(script,input=>{if(input.script.length>600)throw Object.assign(Error('输出长度限制'),{code:'TEXT_OUTPUT_TRUNCATED'});return shot(input);});
 try{await f.workflow.reparseStoryboards(f.project.id,{duration:30});await f.settle();
  assert.equal(f.project.storyboardReparse.state,'completed');assert.ok(f.project.shots.length>1);
  assert.equal(f.project.chunks.map(c=>c.text).join(''),script);assert.ok(f.project.chunks.every(c=>c.storyboardState==='completed'));
  assert.ok(f.project.logs.some(l=>/自动拆成/.test(l.message)));
 }finally{await f.cleanup();}
});

test('某段没有返回分镜或引用写错时自动重试，不需要手动继续；用素材名称引用也能识别',async()=>{
 const script='场景一：房间\n主角：“第一句。”\n场景二：走廊\n主角：“第二句。”\n';
 const f=await fixture(script,(input,n)=>n===1?{shots:[]}:n===2?shot(input,'不存在的key'):shot(input,'主角'));
 try{await f.workflow.reparseStoryboards(f.project.id,{duration:30});await f.settle();
  assert.equal(f.project.storyboardReparse.state,'completed');assert.equal(f.calls.length,4);assert.equal(f.project.shots.length,2);
  assert.ok(f.project.shots.every(s=>s.assetIds.join()==='hero-id'&&s.promptTemplate.includes('{{ref:hero-id}}')));
 }finally{await f.cleanup();}
});

test('连续三次都不合格才报失败，旧分镜保留',async()=>{
 const f=await fixture('场景一：房间\n主角：“第一句。”\n',()=>({shots:[]}));
 try{await f.workflow.reparseStoryboards(f.project.id,{duration:30});await f.settle();
  assert.equal(f.project.storyboardReparse.state,'failed');assert.equal(f.calls.length,3);assert.equal(f.project.shots[0].id,'old');
 }finally{await f.cleanup();}
});

test('已有资产图时修改剧本：不用另建项目，重新解析分镜即可，资产图原样保留且不提交生图',async()=>{
 const f=await fixture('场景一：房间\n主角：“旧台词。”\n',input=>shot(input));
 try{const image=structuredClone(f.project.assets[0].image);
  await f.workflow.updateProject(f.project.id,{script:'场景一：房间\n主角：“新台词。”\n'});assert.equal(f.project.sourceChanged,true);
  assert.throws(()=>f.workflow.review(f.project.id,['old']),/重新解析分镜/);
  await f.workflow.reparseStoryboards(f.project.id,{duration:30});await f.settle();
  assert.equal(f.project.storyboardReparse.state,'completed');assert.equal(f.project.sourceChanged,undefined);
  assert.match(f.project.shots[0].promptTemplate,/新台词/);assert.deepEqual(f.project.assets[0].image,image);assert.equal(f.images(),0);
 }finally{await f.cleanup();}
});

const profile=(service,extra={})=>({service,baseUrl:'https://vendor.example',apiKey:'secret-key',model:'m1',protocol:{deepseek:'openai-chat',grsai:'grsai',fydmai:'openai-video'}[service],...extra});
const fake=handler=>{const calls=[];const fetchImpl=async(url,init)=>{calls.push({path:new URL(url).pathname,method:init.method,body:init.body});const [status,payload]=handler(new URL(url).pathname,init);return{status,ok:status<400,json:async()=>payload};};return{calls,fetchImpl};};

test('视频和生图的连接测试只发GET查询，绝不提交生成任务',async()=>{
 for(const service of ['fydmai','grsai'])for(const protocol of service==='fydmai'?['fydmai','openai-video']:['grsai','openai-images']){
  const ok=fake(path=>path==='/v1/models'?[200,{data:[{id:'m1'}]}]:[404,{}]);const result=await testProvider(profile(service,{protocol}),ok);
  assert.equal(result.level,'ok');assert.ok(ok.calls.length&&ok.calls.every(c=>c.method==='GET'&&c.body===undefined));assert.ok(!JSON.stringify(result).includes('secret-key'));
  const partial=fake(()=>[404,{}]);const reachable=await testProvider(profile(service,{protocol}),partial);
  assert.equal(reachable.level,'reachable');assert.ok(partial.calls.every(c=>c.method==='GET'));
 }
 const denied=fake(()=>[401,{}]);assert.equal((await testProvider(profile('fydmai'),denied)).level,'fail');
 const missing=fake(()=>[200,{data:[{id:'other'}]}]);assert.match((await testProvider(profile('fydmai'),missing)).message,/没有 m1/);
 const down={fetchImpl:async()=>{throw Error('offline');}};assert.match((await testProvider(profile('fydmai'),down)).message,/连不上/);
 assert.equal((await testProvider(profile('fydmai',{apiKey:''}),denied)).level,'fail');
});

test('文本的连接测试只发一次极短对话',async()=>{
 const ok=fake(()=>[200,{choices:[{message:{content:'ok'}}]}]);const result=await testProvider(profile('deepseek'),ok);
 assert.equal(result.level,'ok');assert.equal(ok.calls.length,1);assert.equal(JSON.parse(ok.calls[0].body).max_tokens,16);
 const denied=fake(()=>[401,{}]);assert.match((await testProvider(profile('deepseek'),denied)).message,/Key 被拒绝/);
});
