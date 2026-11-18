import {ApiClient} from './http.js';
import {expandTemplate} from './custom-providers.js';
import {SCENETRA_MODELS} from './scenetra.js';

// 连接测试。文本用一次极短的对话验证；生图和视频只发 GET 查询，不提交任何生成任务，不会产生生成费用。
// 不回显 Key、请求头或上游原始响应。
const PROBE_ID='connection-test';
const TIMEOUT_MS=15000;

async function call(profile,path,{method='GET',json,fetchImpl=fetch}={}){
 const client=new ApiClient(profile);
 if(!profile.apiKey)return {missingKey:true};
 if(!path.startsWith('/')||path.startsWith('//'))return {badPath:true};
 const headers={[client.authHeader]:`${client.authPrefix}${profile.apiKey}`};
 if(json!==undefined)headers['Content-Type']='application/json';
 try{
  const response=await fetchImpl(new URL(`${client.baseUrl}${path}`),{method,headers,redirect:'error',body:json===undefined?undefined:JSON.stringify(json),signal:AbortSignal.timeout(TIMEOUT_MS)});
  let payload=null;try{payload=await response.json();}catch{}
  return {status:response.status,payload};
 }catch{return {network:true};}
}

const fail=message=>({level:'fail',message});
function rejected(result){
 if(result.missingKey)return fail('这个方案还没有填 Key。');
 if(result.badPath)return fail('接口路径无效，路径必须以单个 / 开头。');
 if(result.network)return fail('连不上：地址填错、网络不通，或 15 秒内没有响应。');
 if(result.status===401||result.status===403)return fail(`Key 被拒绝（HTTP ${result.status}）：Key 填错、已失效，或认证请求头/前缀不对。`);
 if(result.status===402)return fail('已连通，但服务返回余额不足（HTTP 402）。');
 if(result.status===429)return fail('已连通，但被限流或额度用尽（HTTP 429），稍后再试。');
 if(result.status>=500)return fail(`服务端报错（HTTP ${result.status}），厂商那边暂时不可用。`);
 return null;
}
function modelIds(payload){const list=Array.isArray(payload?.data)?payload.data:Array.isArray(payload?.models)?payload.models:Array.isArray(payload)?payload:[];return list.map(item=>typeof item==='string'?item:item?.id||item?.model||item?.name).filter(Boolean);}

async function testText(profile,fetchImpl){
 let path,json;
 if(profile.protocol==='json'){
  const messages=[{role:'user',content:'连接测试，只回复 {"ok":true}'}];
  path=profile.adapter?.submitPath||'';json=expandTemplate(profile.adapter?.request||{},{model:profile.model,instructions:'连接测试',input:'只回复 {"ok":true}',maxTokens:16,messages});
 }else{
  path=profile.submitPath||'/chat/completions';json={model:profile.model,messages:[{role:'user',content:'连接测试，只回复 ok'}],max_tokens:16,stream:false};
 }
 const result=await call(profile,path,{method:'POST',json,fetchImpl});
 const bad=rejected(result);if(bad)return bad;
 if(result.status===404)return fail('地址或提交路径不对（HTTP 404），也可能是模型 ID 不存在。');
 if(result.status>=400)return fail(`请求被拒绝（HTTP ${result.status}），多半是模型 ID 或提交路径不对。`);
 if(!result.payload||typeof result.payload!=='object')return fail('接口有响应，但返回的不是 JSON，请核对地址和提交路径。');
 return {level:'ok',message:`文本接口可用：地址、Key 和模型 ${profile.model} 都通过了一次真实对话（只消耗几个字的额度）。`};
}

async function testMedia(profile,service,fetchImpl){
 const kind=service==='grsai'?'图片':'视频';
 const note=`没有提交${kind}生成，不产生生成费用。`;
 const queries=[];
 if(profile.protocol==='grsai')queries.push(`/v1/api/result?id=${PROBE_ID}`);
 else if(profile.protocol==='json'){if(profile.adapter?.queryPath)queries.push(profile.adapter.queryPath.replaceAll('{id}',PROBE_ID));}
 else if(profile.protocol!=='openai-images')queries.push(`/v1/videos/${PROBE_ID}`);
 if(profile.protocol==='huimiao'){
  // 惠喵：GET /v1/models 和 /v1/balance 都免费，顺便报出所选模型的真实能力和积分余额。
  const list=await call(profile,'/v1/models',{fetchImpl});
  const refused=rejected(list);if(refused)return refused;
  if(list.status!==200)return fail(`惠喵返回 HTTP ${list.status}，请核对地址（分站用户填自己分站的域名）`);
  const models=Array.isArray(list.payload?.data)?list.payload.data:[];
  const entry=models.find(item=>item?.id===profile.model);
  const b=await call(profile,'/v1/balance',{fetchImpl});
  const available=b.payload?.available??b.payload?.available_credits??b.payload?.balance;
  const balance=b.status===200&&Number.isFinite(Number(available))?`可用积分 ${Number(available).toLocaleString('zh-CN',{maximumFractionDigits:2})}。`:'';
  if(!entry)return {level:'reachable',message:`Key 有效，但惠喵现在没有开放 ${profile.model}。可用模型：${models.map(item=>item.id).filter(Boolean).slice(0,20).join('、')||'无'}。${balance}${note}`};
  const caps=`时长 ${entry.min_duration}～${entry.max_duration} 秒，清晰度 ${(entry.supported_resolutions||[entry.resolution]).filter(Boolean).join('/')}，最多 ${entry.max_images} 张参考图、${entry.max_audios} 段参考音频`;
  return {level:'ok',message:`Key 有效，${entry.name||profile.model}：${caps}。清晰度和时长请和“视频参数”里保持一致。${balance}${note}`};
 }
 if(profile.protocol==='scenetra'){
  // Scenetra：GET /api/v1/models 免费，能验证 Key，也能看所选模型是否开放 API。
  const list=await call(profile,'/api/v1/models',{fetchImpl});
  const refused=rejected(list);if(refused)return refused;
  if(list.status!==200)return fail(`Scenetra 返回 HTTP ${list.status}，请核对地址是否为 https://app.scenetra.com`);
  const model=SCENETRA_MODELS[profile.model];if(!model)return fail('请从列表里选择 Scenetra 的模型。');
  const ids=modelIds(list.payload);
  const missing=[model.t2v,model.ref].filter(id=>ids.length&&!ids.includes(id));
  if(missing.length===2)return {level:'reachable',message:`Key 有效，但 Scenetra 现在没有开放 ${model.label} 的 API，请换一个模型。${note}`};
  if(missing.length)return {level:'reachable',message:`Key 有效。${model.label} 的${missing[0]===model.ref?'参考图生视频':'纯文字生视频'}暂时没开放，${missing[0]===model.ref?'带参考图':'不带参考图'}时会失败。${note}`};
  return {level:'ok',message:`Key 有效，${model.label} 的文字生视频和参考图生视频都已开放。${note}积分余额要到真正生成时才能确认。`};
 }
 const models=await call(profile,'/v1/models',{fetchImpl});
 const bad=rejected(models);if(bad)return bad;
 if(models.status===200){
  let ids=modelIds(models.payload);
  // 菲阳的 /v1/models 不列未上架的型号，详细状态在 /caps。
  if(profile.protocol==='fydmai'){
   const caps=await call(profile,'/caps',{fetchImpl});
   const entry=caps.status===200&&Array.isArray(caps.payload?.models)?caps.payload.models.find(item=>item?.model===profile.model):null;
   if(entry?.onShelf===false)return {level:'reachable',message:`地址和 Key 有效，但厂商当前把 ${profile.model} 标记为未上架，现在提交会被拒绝。${note}`};
   if(entry)ids=[...ids,profile.model];
  }
  // 萤漫这类接口有 GET /v1/balance，顺便把积分余额查出来；没有这个接口的厂商会返回 404，忽略即可。
  let balance='';
  if(profile.protocol==='openai-video'){
   const b=await call(profile,'/v1/balance',{fetchImpl});
   if(b.status===200&&Number.isFinite(Number(b.payload?.available))){const n=v=>Number(v).toLocaleString('zh-CN',{maximumFractionDigits:2});balance=`可用积分 ${n(b.payload.available)}${Number(b.payload.frozen)>0?`，冻结 ${n(b.payload.frozen)}`:''}。`;}
  }
  if(ids.length&&!ids.includes(profile.model)){
   // 列出厂商实际提供的同类模型 ID，方便直接照着改。
   const list=Array.isArray(models.payload?.data)?models.payload.data:[];
   const same=list.filter(item=>item&&typeof item==='object'&&String(item.capability||'').toLowerCase()===(service==='grsai'?'image':'video')).map(item=>item.id).filter(Boolean);
   const hint=same.length?`厂商的${kind}模型 ID 有：${same.slice(0,20).join('、')}${same.length>20?' 等':''}。`:'';
   return {level:'reachable',message:`地址和 Key 有效，但厂商的模型列表里没有 ${profile.model}，请核对模型 ID。${hint}${balance}${note}`};
  }
  return {level:'ok',message:`地址和 Key 有效${ids.length?`，模型 ${profile.model} 在厂商的模型列表里`:''}。${balance}${note}${balance?'':'余额和生成权限要到真正生成时才能确认。'}`};
 }
 for(const path of queries){
  const result=await call(profile,path,{fetchImpl});
  const refused=rejected(result);if(refused)return refused;
  return {level:'reachable',message:`服务可以连通，Key 没有被拒绝。这家厂商没有免费的校验接口，无法进一步确认 Key 和余额。${note}`};
 }
 return {level:'reachable',message:`服务可以连通，但这家厂商没有可免费校验 Key 的接口，Key 是否有效要到真正生成时才知道。${note}`};
}

async function testVoice(profile,fetchImpl){
 const result=await call(profile,'/v1/t2a_v2',{method:'POST',json:{model:profile.model||'speech-2.8-hd',text:'测试',stream:false,voice_setting:{voice_id:'male-qn-qingse',speed:1,vol:1,pitch:0}},fetchImpl});
 const bad=rejected(result);if(bad)return bad;
 const code=result.payload?.base_resp?.status_code;
 if(code===1004)return fail('Key 被 MiniMax 拒绝（1004）：请检查 API Key 是否正确。');
 if(code===1008)return fail('Key 有效，但 MiniMax 账户余额不足（1008），请先充值。');
 if(code!==undefined&&code!==0)return fail(`MiniMax 返回错误（${code}）：${result.payload?.base_resp?.status_msg||'请求失败'}`);
 if(result.status>=400)return fail(`请求被拒绝（HTTP ${result.status}），请检查模型 ID 或接口地址。`);
 return {level:'ok',message:`语音接口可用：Key 和模型 ${profile.model} 验证通过。`};
}

export async function testProvider(profile,{fetchImpl=fetch}={}){
 if(!profile||!profile.service)return fail('厂商方案不存在。');
 try{new ApiClient(profile);}catch(error){return fail(error.message);}
 if(!profile.apiKey)return fail('这个方案还没有填 Key。');
 if(!profile.model)return fail('这个方案还没有选模型。');
 return profile.service==='deepseek'?testText(profile,fetchImpl):profile.service==='minimax'?testVoice(profile,fetchImpl):testMedia(profile,profile.service,fetchImpl);
}
