import {ApiClient} from './http.js';
import {localImageReference,DeepSeekProvider,GrsaiImageProvider,FydmaiVideoProvider} from './providers.js';
import {readFile,mkdir,writeFile,rename,rm} from 'node:fs/promises';import {basename,dirname} from 'node:path';import {ScenetraVideoProvider,scenetraImageTag} from './scenetra.js';import {randomUUID} from 'node:crypto';
export function getPath(value,path){if(!path)return undefined;return String(path).split('.').reduce((v,key)=>v?.[key],value);}
export function expandTemplate(value,variables){
 if(Array.isArray(value))return value.map(v=>expandTemplate(v,variables));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,expandTemplate(v,variables)]));
 if(typeof value!=='string')return value;
 const full=value.match(/^\{\{(\w+)\}\}$/);if(full)return variables[full[1]];
 return value.replace(/\{\{(\w+)\}\}/g,(_,key)=>String(variables[key]??''));
}
function imageUrls(raw,map){const value=getPath(raw,map.url);const values=Array.isArray(value)?value:[value];return values.filter(v=>typeof v==='string'&&v);}
class JsonProvider{
 constructor(config){this.config=config;this.api=new ApiClient(config);this.adapter=config.adapter;}
 normalize(raw){
  const a=this.adapter,m=a.response,id=getPath(raw,m.id),urls=imageUrls(raw,m);
  const remote=getPath(raw,m.status),status=remote===undefined&&urls.length?'completed':a.states?.[remote];
  if(!['queued','running','completed','failed'].includes(status))throw Error('自定义接口状态无法映射，请检查响应字段和状态映射');
  if(status==='completed'&&!urls.length)throw Error('接口显示完成但没有成品地址');
  if(!id&&status!=='completed')throw Error('异步接口未返回任务ID');
  return{id:String(id||`sync-${crypto.randomUUID()}`),status,urls,progress:Number(getPath(raw,m.progress))||0,error:getPath(raw,m.error)?'供应商任务失败，请查看供应商控制台':null};
 }
 async submit(input){const mapReference=(items=[])=>items.map(({assetId})=>this.adapter.referenceItem==='object'?{assetId}:assetId);const vars={...input,model:this.config.model,referenceImages:mapReference(input.referenceImages),referenceAudios:mapReference(input.referenceAudios)};vars.images=vars.referenceImages||input.images||[];
  return this.normalize(await this.api.request(this.adapter.submitPath,{method:'POST',json:expandTemplate(this.adapter.request,vars)}));}
 async getTask(id){if(!this.adapter.queryPath)throw Error('异步任务未配置查询路径');return this.normalize(await this.api.request(this.adapter.queryPath.replaceAll('{id}',encodeURIComponent(id))));}
 async generateJson({instructions,input,maxTokens}){
  const vars={model:this.config.model,instructions:`${instructions}\n只输出JSON对象。`,input,maxTokens,messages:[{role:'system',content:instructions+'\n只输出JSON对象。'},{role:'user',content:input}]};
  const raw=await this.api.request(this.adapter.submitPath,{method:'POST',json:expandTemplate(this.adapter.request,vars)});
  const value=getPath(raw,this.adapter.response.text);let result;try{result=typeof value==='string'?JSON.parse(value):value;}catch{throw Error('文本接口返回内容不是有效JSON');}
  if(!result||typeof result!=='object'||Array.isArray(result))throw Error('文本响应字段不是JSON对象');return result;
 }
 async uploadImage(path){ return this.uploadReference(path,'image'); }
 async uploadAudio(path){ return this.uploadReference(path,'audio'); }
 async uploadReference(path,kind='image'){
  if(this.adapter.referenceMode==='data-url'){
   if(kind==='audio') throw Error('自定义 data-url 适配器未配置音频 data-url 转换，请改用 upload 方式');
   return{assetId:await localImageReference(path)};
  }
  const bytes=await readFile(path),lower=path.toLowerCase();const type=kind==='audio'?(lower.endsWith('.wav')?'audio/wav':lower.endsWith('.m4a')?'audio/mp4':'audio/mpeg'):(lower.endsWith('.jpg')||lower.endsWith('.jpeg')?'image/jpeg':lower.endsWith('.webp')?'image/webp':'image/png');
  const form=new FormData();form.append(this.adapter.uploadField||'file',new Blob([bytes],{type}),basename(path));
  const raw=await this.api.request(this.adapter.uploadPath,{method:'POST',form});const id=getPath(raw,this.adapter.uploadResultPath);
  if(typeof id!=='string'||!id)throw Error('参考图上传响应未返回配置的ID字段');return{assetId:id};
 }
 async getCapabilities(){return{models:[{kind:'video',model:this.config.model,...this.config.capabilities}]};}
}

function yingmanTask(raw) {
 const statusMap={queued:'queued',in_progress:'running',running:'running',completed:'completed',failed:'failed'};
 const status=statusMap[raw?.status];
 if(!raw?.id)throw Error('萤漫视频响应未返回任务ID');
 if(!status)throw Error('萤漫返回了未知任务状态');
 return {id:String(raw.id),status,progress:Number(raw.progress)||0,urls:raw.url?[raw.url]:[],error:raw.error||raw.message||null};
}

class YingmanVideoProvider {
 constructor(config){this.config=config;this.api=new ApiClient(config);}
 async uploadImage(path){return{assetId:path,filename:basename(path)};}
 async uploadAudio(path){return{assetId:path,filename:basename(path)};}
 async submit({prompt,duration,resolution,referenceImages=[],referenceAudios=[]}){
  const form=new FormData();
  form.append('model',this.config.model);
  form.append('prompt',prompt);
  form.append('seconds',String(duration));
  const size={ '720p':'1280x720','1080p':'1920x1080','16:9':'1280x720','9:16':'720x1280' }[resolution]||resolution||'1280x720';
  form.append('size',size);
  for(const item of referenceImages){const path=item?.assetId;if(typeof path!=='string'||!path)throw Error('萤漫参考图路径无效');const bytes=await readFile(path);form.append('input_reference',new Blob([bytes],{type:this.mime(path,'image')}),basename(path));}
  for(const item of referenceAudios){const path=item?.assetId;if(typeof path!=='string'||!path)throw Error('萤漫参考音频路径无效');const bytes=await readFile(path);form.append('input_audio',new Blob([bytes],{type:this.mime(path,'audio')}),basename(path));}
  return yingmanTask(await this.api.request(this.config.submitPath||'/v1/videos',{method:'POST',form}));
 }
 mime(path,kind){const lower=path.toLowerCase();if(kind==='audio')return lower.endsWith('.wav')?'audio/wav':lower.endsWith('.m4a')?'audio/mp4':'audio/mpeg';return lower.endsWith('.jpg')||lower.endsWith('.jpeg')?'image/jpeg':lower.endsWith('.webp')?'image/webp':'image/png';}
 async getTask(id){return yingmanTask(await this.api.request(`/v1/videos/${encodeURIComponent(id)}`));}
 async getCapabilities(){return{models:[{kind:'video',model:this.config.model,minDuration:4,maxDuration:30,defaultDuration:30,resolutions:['720p'],defaultResolution:'720p',maxReference:10}]};}
 async downloadTask(id,destination){
  const url=new URL(`/v1/videos/${encodeURIComponent(id)}/content`,this.config.baseUrl);
  // 文档示例用 curl -L：content 接口可能跳转到存储地址。跳转时只跟一次，且不把 Key 带到别的域名。
  let response=await this.api.fetchImpl(url,{headers:{[this.api.authHeader]:`${this.api.authPrefix}${this.api.apiKey}`},redirect:'manual',signal:AbortSignal.timeout(180000)});
  if(response.status>=300&&response.status<400){
   const next=new URL(response.headers.get('location')||'',url);if(next.protocol!=='https:')throw Error('萤漫成片下载地址必须为 HTTPS');
   response=await this.api.fetchImpl(next,{headers:next.origin===url.origin?{[this.api.authHeader]:`${this.api.authPrefix}${this.api.apiKey}`}:{},redirect:'error',signal:AbortSignal.timeout(180000)});
  }
  if(!response.ok)throw Error(`萤漫成片下载失败 HTTP ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());if(!bytes.length)throw Error('萤漫成片为空');
  await mkdir(dirname(destination),{recursive:true});const temp=`${destination}.${randomUUID()}.part`;
  try{await writeFile(temp,bytes,{mode:0o600,flag:'wx'});await rename(temp,destination);}finally{await rm(temp,{force:true});}
  return{path:destination,bytes:bytes.length};
 }
}
class OpenAIImageProvider{
 constructor(config){this.config=config;this.api=new ApiClient(config);}
 async submit({prompt,aspectRatio,images=[]}){
  if(images.length)throw Error('当前OpenAI Images兼容协议配置为纯生图；带参考图编辑请配置自定义上传协议');
  const sizes={'16:9':'1536x1024','9:16':'1024x1536','1:1':'1024x1024'};
  const raw=await this.api.request(this.config.submitPath||'/v1/images/generations',{method:'POST',json:{model:this.config.model,prompt,n:1,size:this.config.imageSize||sizes[aspectRatio]||'1024x1024'}});
  const urls=(raw.data||[]).map(item=>item.url||(item.b64_json?`data:image/png;base64,${item.b64_json}`:null)).filter(Boolean);
  if(!urls.length)throw Error('图片响应没有data[].url或b64_json');return{id:`sync-${crypto.randomUUID()}`,status:'completed',urls};
 }
}
export function createProvider(service,config){if(config.protocol==='json')return new JsonProvider(config);if(service==='deepseek')return new DeepSeekProvider(config);if(service==='grsai')return config.protocol==='openai-images'?new OpenAIImageProvider(config):new GrsaiImageProvider(config);if(config.protocol==='openai-video')return new YingmanVideoProvider(config);if(config.protocol==='scenetra')return new ScenetraVideoProvider(config);return new FydmaiVideoProvider(config);}
export function referenceTag(config,slot){if(config.protocol==='scenetra')return `${scenetraImageTag(config.model,slot.index)} `;if(config.protocol==='openai-video')return `@图片${slot.index} `;if(config.protocol!=='json')return `@${slot.filename} `;return config.adapter.referenceTag.replaceAll('{index}',String(slot.index)).replaceAll('{name}',slot.name).replaceAll('{filename}',slot.filename)+' ';}
