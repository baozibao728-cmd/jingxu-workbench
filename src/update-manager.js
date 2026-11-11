import {readFile,writeFile,mkdir,rename,copyFile,stat,lstat,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';import {createHash,randomUUID} from 'node:crypto';
const versionPattern=/^v?\d+\.\d+\.\d+$/;
export const updateManifestName='jingxu-update.json';
export function isProgramPath(path){
 if(typeof path!=='string'||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..'))return false;
 if(path.split('/').some(p=>p.startsWith('.')))return false;
 return ['package.json','README.md','启动工作台.command','启动工作台.bat','创建桌面快捷方式.command','创建桌面快捷方式.bat'].includes(path)||/^(src|public|prompts|test|docs)\/[\p{L}\p{N}_.\/-]+$/u.test(path);
}
function newer(a,b){const x=a.replace(/^v/,'').split('.').map(Number),y=b.replace(/^v/,'').split('.').map(Number);for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]>y[i];}return false;}
async function boundedJson(response,max){if(!response.ok)throw Error(`更新服务器返回HTTP ${response.status}`);let length=0;const chunks=[];for await(const chunk of response.body){length+=chunk.length;if(length>max)throw Error('更新包超过大小限制');chunks.push(Buffer.from(chunk));}return JSON.parse(Buffer.concat(chunks).toString());}
export function validateUpdateManifest(manifest){
 if(!manifest||!versionPattern.test(manifest.version)||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>1000)throw Error('更新清单格式无效');
 const seen=new Set();let total=0;const files=manifest.files.map(item=>{
  if(!isProgramPath(item.path)||seen.has(item.path)||typeof item.content!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256))throw Error('更新清单含不允许的路径或摘要');seen.add(item.path);
  const bytes=Buffer.from(item.content,'base64');total+=bytes.length;if(total>100*1024*1024)throw Error('更新包过大');
  if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('更新文件完整性校验失败');return{...item,bytes};
 });
 if(!seen.has('package.json')||!seen.has('src/server.js'))throw Error('更新包缺少必要程序文件');
 const pkg=JSON.parse(files.find(item=>item.path==='package.json').bytes.toString());if(pkg.version!==manifest.version.replace(/^v/,''))throw Error('版本号与更新包不一致');
 return files;
}
async function assertNoSymlink(root,path){const parts=path.split('/');let cursor=root;for(const part of parts){cursor=join(cursor,part);try{if((await lstat(cursor)).isSymbolicLink())throw Error('更新目标含符号链接，停止更新');}catch(e){if(e.code!=='ENOENT')throw e;}}}

export class UpdateManager{
 constructor(root,{fetchImpl=fetch,isBusy=()=>false,repository='',restart}={}){this.root=root;this.fetch=fetchImpl;this.isBusy=isBusy;this.restart=restart;this.config={repository,autoCheck:true,autoInstall:true};this.status={state:'idle'};this.latest=null;this.busy=false;}
 async init(){this.version=JSON.parse(await readFile(join(this.root,'package.json'),'utf8')).version||'0.0.0';try{this.config={...this.config,...JSON.parse(await readFile(join(this.root,'data/update-settings.json'),'utf8'))};}catch(e){if(e.code!=='ENOENT')throw e;}try{this.status={state:'idle',lastInstall:JSON.parse(await readFile(join(this.root,'data/update-last.json'),'utf8'))};}catch{}}
 view(){return{...this.status,version:this.version,config:this.config};}
 async save(input){const repository=String(input.repository??this.config.repository).trim();if(repository&&!/^[\w.-]+\/[\w.-]+$/.test(repository))throw Error('仓库格式应为账号/仓库名');for(const key of ['autoCheck','autoInstall'])if(input[key]!==undefined&&typeof input[key]!=='boolean')throw Error('更新开关必须为布尔值');
 this.config={repository,autoCheck:input.autoCheck??this.config.autoCheck,autoInstall:input.autoInstall??this.config.autoInstall};await mkdir(join(this.root,'data'),{recursive:true});await writeFile(join(this.root,'data/update-settings.json'),JSON.stringify(this.config,null,2),{mode:0o600});this.latest=null;this.status={state:'idle'};return this.view();}
 async check(){if(!this.config.repository){this.status={state:'unconfigured',message:'尚未设置GitHub发布仓库'};return this.view();}
 const repo=this.config.repository;
 try{const release=await boundedJson(await this.fetch(`https://api.github.com/repos/${repo}/releases/latest`,{headers:{Accept:'application/vnd.github+json','User-Agent':'Jingxu-Updater'},signal:AbortSignal.timeout(20000)}),1024*1024);
 if(!versionPattern.test(release.tag_name))throw Error('GitHub Release版本标签应为v数字.数字.数字');
 const asset=release.assets?.find(a=>a.name===updateManifestName);if(!asset)throw Error('最新Release缺少jingxu-update.json');
 const expected=`https://github.com/${repo}/releases/download/`;
 if(!asset.browser_download_url?.startsWith(expected))throw Error('更新地址不属于已配置的仓库');
 const available=newer(release.tag_name,this.version);this.latest=available?{version:release.tag_name,url:asset.browser_download_url}:null;
 this.status={state:available?'available':'current',latest:release.tag_name,checkedAt:new Date().toISOString(),message:available?'发现新版本':'已是最新版本'};
 }catch(e){this.status={state:'error',message:e.message};}return this.view();}
 async install(){if(this.busy)throw Error('更新正在处理中');if(this.isBusy()){this.status={...this.status,state:'waiting',message:'有任务进行中，空闲后再更新'};return this.view();}if(!this.latest)throw Error('请先检查到可用更新');
 this.busy=true;const latest=this.latest;
 try{const manifest=await boundedJson(await this.fetch(latest.url,{signal:AbortSignal.timeout(60000)}),150*1024*1024);if(manifest.version.replace(/^v/,'')!==latest.version.replace(/^v/,''))throw Error('发布版本与清单版本不一致');
 const files=validateUpdateManifest(manifest);if(this.isBusy()){this.status={...this.status,state:'waiting',message:'有新任务启动，稍后再更新'};return this.view();}
 const backup=join(this.root,'data','program-backups',`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);await mkdir(backup,{recursive:true});const applied=[];
 // Validate every target before writing anything. Backups live under data and contain program bytes only.
 for(const file of files)await assertNoSymlink(this.root,file.path);
 try{for(const file of files){const target=join(this.root,file.path),saved=join(backup,file.path);let exists=false;try{await stat(target);exists=true;await mkdir(dirname(saved),{recursive:true});await copyFile(target,saved);}catch(e){if(e.code!=='ENOENT')throw e;}
  applied.push({target,saved,exists});await mkdir(dirname(target),{recursive:true});const temp=target+'.update-'+randomUUID();await writeFile(temp,file.bytes,{mode:file.path.endsWith('.command')?0o755:0o644});await rename(temp,target);}
 }catch(e){for(const item of applied.reverse()){if(item.exists)await copyFile(item.saved,item.target);else await rm(item.target,{force:true});}throw Error('更新失败，程序文件已回滚；本机数据保持原样');}
 const record={from:this.version,to:manifest.version,backup,at:new Date().toISOString()};await writeFile(join(this.root,'data/update-last.json'),JSON.stringify(record,null,2));this.latest=null;this.status={state:'installed',message:'更新完成，正在重启工作台',lastInstall:record};
 if(this.restart){this.restarting=true;setTimeout(()=>this.restart(),500).unref();}else this.status.message='更新完成，重新启动工作台后生效';
 }catch(e){this.status={state:'error',message:e.message};}finally{this.busy=!!this.restarting;}return this.view();}
 async tick(){if(!this.config.autoCheck||!this.config.repository||this.busy)return;await this.check();if(this.config.autoInstall&&this.latest)await this.install();}
}
