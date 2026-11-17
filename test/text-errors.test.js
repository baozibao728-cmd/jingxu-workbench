import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {DeepSeekProvider,GrsaiImageProvider,parseJsonText,TEXT_MIN_TIMEOUT_MS} from '../src/providers.js';
import {createProvider} from '../src/custom-providers.js';
import {Workflow} from '../src/workflow.js';import {ProjectStore,digest} from '../src/project-store.js';

const timeoutError=()=>Object.assign(new Error('The operation was aborted due to timeout'),{name:'TimeoutError'});
const reply=content=>Response.json({choices:[{finish_reason:'stop',message:{content}}]});
const textProvider=(fetchImpl,extra={})=>new DeepSeekProvider({baseUrl:'https://wkapi.work',submitPath:'/v1/chat/completions',apiKey:'secret-key-123',model:'gemini-3.8-flash',fetchImpl,...extra});
const errorText=error=>Workflow.prototype.errorText.call({},error);

test('文字调用超时显示等待秒数，不再提示核对服务端任务；超时至少按10分钟等',async()=>{
 const text=textProvider(async()=>{throw timeoutError();});
 assert.equal(text.api.timeoutMs,TEXT_MIN_TIMEOUT_MS);
 assert.equal(textProvider(fetch,{timeoutMs:900000}).api.timeoutMs,900000);
 assert.equal(createProvider('deepseek',{baseUrl:'https://x.example',apiKey:'k',model:'m',protocol:'json',timeoutMs:120000,adapter:{submitPath:'/t',request:{},response:{text:'a'}}}).api.timeoutMs,TEXT_MIN_TIMEOUT_MS);
 await assert.rejects(text.generateJson({instructions:'规则',input:'剧本'}),error=>{
  assert.equal(error.submissionUnknown,false);assert.equal(error.code,'TEXT_TIMEOUT');
  const shown=errorText(error);assert.match(shown,/600秒/);assert.match(shown,/超时/);assert.doesNotMatch(shown,/核对服务端/);assert.ok(!shown.includes('secret'));return true;
 });
});

test('文字服务返回HTML错误页、非JSON或HTTP错误时显示状态码和原因，不泄露Key',async()=>{
 const html=textProvider(async()=>new Response('<html>502 Bad Gateway</html>',{status:502,headers:{'content-type':'text/html'}}));
 await assert.rejects(html.generateJson({instructions:'规则',input:'剧本'}),error=>{assert.equal(error.submissionUnknown,false);assert.match(errorText(error),/HTTP 502/);assert.doesNotMatch(errorText(error),/核对服务端|Bad Gateway/);return true;});
 const stream=textProvider(async()=>new Response('data: {"choices":[]}\n\n',{status:200,headers:{'content-type':'text/event-stream'}}));
 await assert.rejects(stream.generateJson({instructions:'规则',input:'剧本'}),error=>/不是JSON（HTTP 200，text\/event-stream）/.test(errorText(error)));
 const denied=textProvider(async()=>Response.json({error:{message:'invalid key secret-key-123 / sk-abcdef1234567'}},{status:401}));
 await assert.rejects(denied.generateJson({instructions:'规则',input:'剧本'}),error=>{const shown=errorText(error);assert.match(shown,/HTTP 401：invalid key/);assert.ok(!shown.includes('secret-key-123')&&!shown.includes('sk-abcdef'));return true;});
 const reset=textProvider(async()=>{throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNRESET'}});});
 await assert.rejects(reset.generateJson({instructions:'规则',input:'剧本'}),error=>/网络中断（ECONNRESET）/.test(errorText(error)));
});

test('模型把JSON包在代码块或前后加说明时照样能读；真不完整时说明收到多少字并允许自动重试',async()=>{
 assert.deepEqual(await textProvider(async()=>reply('```json\n{"shots":[]}\n```')).generateJson({instructions:'规则',input:'剧本'}),{shots:[]});
 assert.deepEqual(parseJsonText('好的，结果如下：{"a":1} 以上'),{a:1});
 assert.throws(()=>parseJsonText('{"shots":[{"title":"半'),error=>error.code==='TEXT_OUTPUT_TRUNCATED'&&/只写了一半/.test(error.message));
 assert.throws(()=>parseJsonText('```json\n{"shots":[{"title":"半'),error=>error.code==='TEXT_OUTPUT_TRUNCATED');
 assert.throws(()=>parseJsonText('抱歉，我无法完成'),error=>error.code==='TEXT_JSON_INVALID'&&error.retryable===true&&/收到\d+字/.test(error.message));
 assert.deepEqual(await textProvider(async()=>Response.json({choices:[{finish_reason:'STOP',message:{content:'{"a":2}'}}]})).generateJson({instructions:'规则',input:'剧本'}),{a:2});
});

test('图片、视频提交中断仍保持谨慎提示并标记结果未知，同时带上原因',async()=>{
 const image=new GrsaiImageProvider({baseUrl:'https://grsaiapi.com',apiKey:'secret-key',model:'gpt-image-2',fetchImpl:async()=>{throw timeoutError();}});
 await assert.rejects(image.submit({prompt:'人物图'}),error=>{assert.equal(error.submissionUnknown,true);const shown=errorText(error);assert.match(shown,/^提交结果暂不明确（等待超过120秒仍未返回，已超时），请先核对服务端任务/);assert.doesNotMatch(shown,/。$/);return true;});
});

async function fixture(script){
 const root=await mkdtemp(join(tmpdir(),'jingxu-text-err-')),store=new ProjectStore(root);await store.init();const project=await store.create({script,skipReview:true});
 const bytes=Buffer.from('fake-image');await writeFile(store.media(project.id,'hero.png'),bytes);
 project.assets=[{id:'hero-id',sourceKey:'hero',name:'主角',kind:'character',selected:true,description:'同一造型',job:{state:'completed'},image:{file:'hero.png',sha256:digest(bytes),filename:'hero.png'}}];
 project.shots=[{id:'old',title:'旧分镜',duration:15,promptTemplate:'{{ref:hero-id}} 旧内容',assetIds:['hero-id'],history:[],job:{state:'completed'}}];await store.save(project);
 const config=()=>({deepseek:{apiKey:'fake-text',baseUrl:'https://text.example',model:'mock'},grsai:{apiKey:'fake-image',baseUrl:'https://image.example',model:'mock'},fydmai:{apiKey:'fake-video',baseUrl:'https://video.example',model:'c7-wan3'}});
 const workflow=new Workflow(store,config,{factories:{}});
 return{store,project,workflow,settle:()=>workflow.active.get(`reparse:${project.id}`),cleanup:async()=>{workflow.stopping=true;await Promise.allSettled([...workflow.active.values()]);await rm(root,{recursive:true,force:true});}};
}
const longScene=`场景1：出租屋书桌前\n${Array.from({length:60},(_,i)=>`主角：“这是第${i+1}句比较长的原文台词。”`).join('\n')}\n`;

test('全部重新解析遇到文字超时，长段落自动拆成两小段再解析，只拆一次',async()=>{
 const f=await fixture(longScene);try{
  const inputs=[];let calls=0;
  f.workflow.factories.text=()=>textProvider(async(_url,options)=>{calls++;const input=JSON.parse(JSON.parse(options.body).messages[1].content);inputs.push(input.script.length);if(calls===1)throw timeoutError();return reply(JSON.stringify({shots:[{title:'新分镜',duration:30,promptTemplate:'{{ref:hero}} 0-30秒说话。'}]}));});
  await f.workflow.reparseStoryboards(f.project.id,{duration:30});await f.settle();
  assert.equal(f.project.storyboardReparse.state,'completed');assert.equal(calls,3);assert.ok(inputs[1]<inputs[0]&&inputs[2]<inputs[0]);assert.equal(f.project.shots.length,2);
  assert.ok(f.project.logs.some(l=>/文字服务超时未返回，已自动拆成2小段/.test(l.message)));
 }finally{await f.cleanup();}
});

test('全部重新解析中断日志显示文字服务真实原因，句号不重复，旧分镜保留',async()=>{
 const f=await fixture('场景1：房间\n主角：“一句。”\n');try{
  f.workflow.factories.text=()=>textProvider(async()=>{throw timeoutError();});
  await f.workflow.reparseStoryboards(f.project.id,{duration:30});await f.settle();
  assert.equal(f.project.storyboardReparse.state,'failed');assert.equal(f.project.shots[0].id,'old');
  const log=f.project.logs.find(l=>l.message.startsWith('全部重新解析中断'));
  assert.match(log.message,/^全部重新解析中断：文字服务请求失败：等待超过600秒仍未返回，已超时。旧分镜保留/);assert.doesNotMatch(log.message,/。。|核对服务端/);
  f.workflow.factories.text=()=>({generateJson:async()=>{throw Object.assign(new Error('x'),{submissionUnknown:true});}});
  await f.workflow.reparseStoryboards(f.project.id,{resume:true});await f.settle();
  assert.doesNotMatch(f.project.logs.filter(l=>l.message.startsWith('全部重新解析中断')).at(-1).message,/。。/);
 }finally{await f.cleanup();}
});

test('全部重新解析时模型报完成却只写了半个JSON，长段落自动拆小再解析',async()=>{
 const f=await fixture(longScene);try{
  let calls=0;
  f.workflow.factories.text=()=>textProvider(async()=>{calls++;return reply(calls===1?'```json\n{"shots":[{"title":"写到一半':JSON.stringify({shots:[{title:'新分镜',duration:30,promptTemplate:'{{ref:hero}} 0-30秒说话。'}]}));});
  await f.workflow.reparseStoryboards(f.project.id,{duration:30});await f.settle();
  assert.equal(f.project.storyboardReparse.state,'completed');assert.equal(calls,3);assert.equal(f.project.shots.length,2);
  assert.ok(f.project.logs.some(l=>/输出被截断，已自动拆成2小段/.test(l.message)));
 }finally{await f.cleanup();}
});
