import {providerModels,normalizeModels} from '../public/model-options.js';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ApiClient} from './http.js';
import {SCENETRA_MODELS,SCENETRA_DEFAULT,scenetraPresetModels} from './scenetra.js';
import {HUIMIAO_DEFAULT,huimiaoPresetModels} from './huimiao.js';

export const providerCatalog={
 deepseek:[{id:'deepseek',label:'DeepSeek',icon:'deepseek',protocol:'openai-chat',baseUrl:'https://api.deepseek.com',submitPath:'/chat/completions'},{id:'gemini',label:'Gemini',icon:'gemini',protocol:'openai-chat',baseUrl:'https://generativelanguage.googleapis.com',submitPath:'/v1beta/openai/chat/completions'},{id:'claude',label:'Claude',icon:'claude',protocol:'openai-chat',baseUrl:'https://api.anthropic.com',submitPath:'/v1/chat/completions'},{id:'gpt',label:'GPT',icon:'gpt',protocol:'openai-chat',baseUrl:'https://api.openai.com',submitPath:'/v1/chat/completions'},{id:'wkapi',label:'悟空 API（wkapi）',protocol:'openai-chat',baseUrl:'https://wkapi.work',submitPath:'/v1/chat/completions',model:'gemini-3.8-flash',models:[{id:'gemini-3.8-flash',label:'Gemini 3.8 Flash'},{id:'gemini-3.1-pro',label:'Gemini 3.1 Pro'},{id:'gemini-4-argon',label:'Gemini 4 Argon'},{id:'claude-sonnet-4-6',label:'Claude Sonnet 4.6（需 Claude 分组的 Key）'}]},{id:'openai',label:'OpenAI 兼容（中转站）',protocol:'openai-chat',baseUrl:'',submitPath:'/v1/chat/completions'},{id:'custom',label:'自定义厂商',protocol:'json',baseUrl:''}],
 grsai:[{id:'grsai',label:'Grsai 中转站',protocol:'grsai',baseUrl:'https://grsaiapi.com'},{id:'openai',label:'OpenAI Images 兼容',protocol:'openai-images',baseUrl:'',submitPath:'/v1/images/generations'},{id:'custom',label:'自定义厂商',protocol:'json',baseUrl:''}],
 fydmai:[{id:'fydmai',label:'菲阳动漫',protocol:'fydmai',baseUrl:'https://fydmai.com'},{id:'yingman',label:'萤漫 OpenAI兼容视频',protocol:'openai-video',baseUrl:'https://yingman.xlapis.com',submitPath:'/v1/videos',model:'seedance-2.5-cc',models:[{id:'seedance-2.5-cc',label:'Seedance 2.5'},{id:'seedance-2.5-flash-cc',label:'Seedance 2.5 Flash'}],capabilities:{minDuration:4,maxDuration:30,defaultDuration:30,resolutions:['720p'],defaultResolution:'720p',maxReference:10}},{id:'huimiao',label:'惠喵 Huimiao',protocol:'huimiao',baseUrl:'https://huimiaovip.com',model:HUIMIAO_DEFAULT,models:huimiaoPresetModels(),capabilities:{minDuration:4,maxDuration:15,defaultDuration:10,resolutions:['720p'],defaultResolution:'720p',maxReference:9}},{id:'scenetra',label:'Scenetra',protocol:'scenetra',baseUrl:'https://app.scenetra.com',model:SCENETRA_DEFAULT,models:scenetraPresetModels()},{id:'custom',label:'自定义厂商 / 兼容视频接口',protocol:'json',baseUrl:''}],
};
export const providerIcons=['','deepseek','gemini','claude','gpt','letter'];
export const protocolDefaults={deepseek:'openai-chat',grsai:'grsai',fydmai:'fydmai'};
export const customExample={
 submitPath:'/v1/tasks',queryPath:'/v1/tasks/{id}',uploadPath:'',uploadField:'file',uploadResultPath:'assetId',
 request:{model:'{{model}}',prompt:'{{prompt}}',duration:'{{duration}}',aspect_ratio:'{{aspectRatio}}',images:'{{images}}',referenceAudios:'{{referenceAudios}}'},
 response:{id:'id',status:'status',url:'url',progress:'progress',error:'error',text:'choices.0.message.content'},
 states:{queued:'queued',pending:'queued',running:'running',in_progress:'running',completed:'completed',succeeded:'completed',failed:'failed'},
 referenceMode:'data-url',referenceTag:'@图片{index}',referenceItem:'string',
};
export function safeProvider(config){
 const {apiKey,...safe}=config;return {...safe,models:providerModels(config),configured:!!apiKey};
}
export function validateProvider(service,input){
 const protocol=input.protocol||protocolDefaults[service];
 const allowed={deepseek:['openai-chat','json'],grsai:['grsai','openai-images','json'],fydmai:['fydmai','openai-video','huimiao','scenetra','json']};
 if(!allowed[service]?.includes(protocol))throw Error('请选择该用途支持的接口协议');
 if(!input.baseUrl||!input.model)throw Error('请填写API基础地址和模型ID');
 if(input.icon!==undefined&&!providerIcons.includes(input.icon))throw Error('图标选项无效');
 new ApiClient(input);
 if(input.authHeader&&!/^[A-Za-z0-9-]+$/.test(input.authHeader))throw Error('认证头名称只能包含英文、数字和短横线');
 if(input.authPrefix!==undefined&&(typeof input.authPrefix!=='string'||/[\r\n]/.test(input.authPrefix)))throw Error('认证前缀不能包含换行');
 if(input.submitPath&&(!input.submitPath.startsWith('/')||input.submitPath.startsWith('//')||/[\r\n]/.test(input.submitPath)))throw Error('提交路径必须以单个/开头');
 if(!Number.isInteger(input.timeoutMs)||input.timeoutMs<1000||input.timeoutMs>1800000)throw Error('超时应为1～1800秒');
 if(protocol==='json'){
  const a=input.adapter;if(!a||typeof a!=='object'||Array.isArray(a)||!a.request||!a.response)throw Error('自定义协议需要填写请求模板和响应字段映射');
  for(const field of ['submitPath','queryPath','uploadPath'])if(a[field]&&(!a[field].startsWith('/')||a[field].startsWith('//')||/[\r\n]/.test(a[field])))throw Error('接口路径必须以单个/开头');
  if(!a.submitPath)throw Error('自定义接口必须填写提交路径');
  if(service==='fydmai'){
   if(!['data-url','upload'].includes(a.referenceMode))throw Error('视频参考图方式选择data-url或upload');
   if(a.referenceMode==='upload'&&!a.uploadPath)throw Error('上传参考图方式需要填写上传路径');
   if(typeof a.referenceTag!=='string'||!a.referenceTag.trim())throw Error('请填写参考图引用标记');
  }
 }
 if(protocol==='scenetra'&&!SCENETRA_MODELS[input.model])throw Error('请从列表里选择 Scenetra 的模型');
 if(service==='fydmai'&&(protocol==='json'||protocol==='huimiao')){
  const p=input.capabilities;
  if(!p||![p.minDuration,p.maxDuration,p.defaultDuration,p.maxReference].every(Number.isInteger)||p.minDuration<1||p.maxDuration<p.minDuration||p.defaultDuration<p.minDuration||p.defaultDuration>p.maxDuration||p.maxReference<1||!Array.isArray(p.resolutions)||!p.resolutions.length||!p.resolutions.every(x=>typeof x==='string'&&x)||!p.resolutions.includes(p.defaultResolution))throw Error('自定义视频需填写有效时长、默认时长、分辨率、默认分辨率、参考图数量');
 }
 return {...input,protocol};
}

export class ProviderSettings{
 constructor(path,initial){this.path=path;this.writes=Promise.resolve();this.profiles={};this.selected={};for(const service of Object.keys(protocolDefaults)){const id=`${service}-legacy`;this.profiles[id]={...initial[service],id,name:providerCatalog[service][0].label,service,protocol:protocolDefaults[service],timeoutMs:120000};this.profiles[id].models=providerModels(this.profiles[id]);this.selected[service]=id;}}
 async init(){try{const saved=JSON.parse(await readFile(this.path,'utf8'));if(!saved.profiles||!saved.selected)throw Error('厂商配置文件不完整');this.profiles=saved.profiles;this.selected=saved.selected;for(const profile of Object.values(this.profiles))profile.models=providerModels(profile);}catch(e){if(e.code!=='ENOENT')throw e;}}
 active(service){return this.profiles[this.selected[service]];}
 config(){return Object.fromEntries(Object.keys(protocolDefaults).map(s=>[s,this.active(s)]));}
 byId(id){const p=this.profiles[id];if(!p)throw Error('原任务的厂商配置已不存在');return p;}
 view(){return {selected:this.selected,profiles:Object.values(this.profiles).map(safeProvider),catalog:providerCatalog,customExample};}
 // 删除只是从列表里收起来：已经提交、可能还在计费的任务要靠原配置继续查询，所以记录本身留着。
 async remove(ids){
  const operation=this.writes.catch(()=>{}).then(async()=>{
   if(!Array.isArray(ids)||!ids.length)throw Error('请先选择要删除的方案');
   const profiles=structuredClone(this.profiles);
   for(const id of ids){const profile=profiles[id];if(!profile||profile.archived)throw Error('方案不存在或已删除');if(Object.values(this.selected).includes(id))throw Error('使用中的方案不能删除，请先启用别的方案');profile.archived=true;profile.removed=true;}
   await mkdir(dirname(this.path),{recursive:true});const temp=`${this.path}.${randomUUID()}.tmp`;
   await writeFile(temp,JSON.stringify({profiles,selected:this.selected},null,2),{mode:0o600});await rename(temp,this.path);
   this.profiles=profiles;
  });this.writes=operation;return operation;
 }
 async save(input){
  const operation=this.writes.catch(()=>{}).then(async()=>{
   const profiles=structuredClone(this.profiles),selected={...this.selected};
   for(const service of Object.keys(protocolDefaults))if(input[service]){
    const value=input[service],id=value.profileId==='new'?`${service}-${randomUUID()}`:value.profileId||selected[service];
    if(value.profileId!=='new'&&(!profiles[id]||profiles[id].service!==service))throw Error('厂商配置不存在或用途不匹配');
    const old=profiles[id]||{service,timeoutMs:120000,apiKey:''};
    const next={...old,id,service};
    for(const key of ['name','baseUrl','model','protocol','submitPath','timeoutMs','adapter','capabilities','imageSize','authHeader','authPrefix','models','icon'])if(value[key]!==undefined)next[key]=value[key];
    if(typeof value.apiKey==='string'&&value.apiKey.trim())next.apiKey=value.apiKey.trim();
    for(const field of ['name','baseUrl','model','protocol','submitPath','authHeader'])if(next[field]!==undefined){if(typeof next[field]!=='string'||/[\r\n]/.test(next[field]))throw Error('配置字段不能包含换行');next[field]=next[field].trim();}
    next.models=normalizeModels(next.models??providerModels(next),next.model);
    next.name ||= '自定义厂商';next.authHeader ||= 'Authorization';validateProvider(service,next);
    // Keep connection revisions for already paid tasks, including their original key.
    const comparable=p=>JSON.stringify(Object.fromEntries(Object.entries({...p,authHeader:p.authHeader||'Authorization',authPrefix:p.authPrefix??'Bearer '}).filter(([k])=>!['id','archived','models','name','icon'].includes(k)).sort(([a],[b])=>a.localeCompare(b))));
    let nextId=id;
    if(profiles[id]&&comparable(profiles[id])!==comparable(next)){nextId=`${service}-${randomUUID()}`;profiles[id].archived=true;}
    next.id=nextId;delete next.archived;profiles[nextId]=next;selected[service]=nextId;
   }
   await mkdir(dirname(this.path),{recursive:true});const temp=`${this.path}.${randomUUID()}.tmp`;
   await writeFile(temp,JSON.stringify({profiles,selected},null,2),{mode:0o600});await rename(temp,this.path);
   this.profiles=profiles;this.selected=selected;return this.config();
  });this.writes=operation;return operation;
 }
}
