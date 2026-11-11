import {ApiClient} from './http.js';
import {localImageReference,DeepSeekProvider,GrsaiImageProvider,FydmaiVideoProvider} from './providers.js';
import {readFile} from 'node:fs/promises';import {basename} from 'node:path';
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
 async submit(input){const vars={...input,model:this.config.model,referenceImages:input.referenceImages?.map(({assetId})=>this.adapter.referenceItem==='object'?{assetId}:assetId)};vars.images=vars.referenceImages||input.images||[];
  return this.normalize(await this.api.request(this.adapter.submitPath,{method:'POST',json:expandTemplate(this.adapter.request,vars)}));}
 async getTask(id){if(!this.adapter.queryPath)throw Error('异步任务未配置查询路径');return this.normalize(await this.api.request(this.adapter.queryPath.replaceAll('{id}',encodeURIComponent(id))));}
 async generateJson({instructions,input,maxTokens}){
  const vars={model:this.config.model,instructions:`${instructions}\n只输出JSON对象。`,input,maxTokens,messages:[{role:'system',content:instructions+'\n只输出JSON对象。'},{role:'user',content:input}]};
  const raw=await this.api.request(this.adapter.submitPath,{method:'POST',json:expandTemplate(this.adapter.request,vars)});
  const value=getPath(raw,this.adapter.response.text);let result;try{result=typeof value==='string'?JSON.parse(value):value;}catch{throw Error('文本接口返回内容不是有效JSON');}
  if(!result||typeof result!=='object'||Array.isArray(result))throw Error('文本响应字段不是JSON对象');return result;
 }
 async uploadImage(path){
  if(this.adapter.referenceMode==='data-url')return{assetId:await localImageReference(path)};
  const bytes=await readFile(path),form=new FormData();form.append(this.adapter.uploadField||'file',new Blob([bytes],{type:path.toLowerCase().endsWith('.jpg')?'image/jpeg':path.toLowerCase().endsWith('.webp')?'image/webp':'image/png'}),basename(path));
  const raw=await this.api.request(this.adapter.uploadPath,{method:'POST',form});const id=getPath(raw,this.adapter.uploadResultPath);
  if(typeof id!=='string'||!id)throw Error('参考图上传响应未返回配置的ID字段');return{assetId:id};
 }
 async getCapabilities(){return{models:[{kind:'video',model:this.config.model,...this.config.capabilities}]};}
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
export function createProvider(service,config){if(config.protocol==='json')return new JsonProvider(config);if(service==='deepseek')return new DeepSeekProvider(config);if(service==='grsai')return config.protocol==='openai-images'?new OpenAIImageProvider(config):new GrsaiImageProvider(config);return new FydmaiVideoProvider(config);}
export function referenceTag(config,slot){if(config.protocol!=='json')return `@${slot.filename} `;return config.adapter.referenceTag.replaceAll('{index}',String(slot.index)).replaceAll('{name}',slot.name).replaceAll('{filename}',slot.filename)+' ';}
