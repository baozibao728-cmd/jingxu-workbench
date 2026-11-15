// Public release builder. Does not read .env, data, outputs, or provider settings.
import {readFile,writeFile,readdir,mkdir,lstat} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {isProgramPath,validateUpdateManifest} from '../src/update-manager.js';
export async function buildUpdate(root,destination){
 const paths=['package.json','README.md','启动工作台.command','启动工作台.bat','创建桌面快捷方式.command','创建桌面快捷方式.bat'];
 async function visit(folder){for(const entry of await readdir(join(root,folder),{withFileTypes:true})){const path=folder+'/'+entry.name;if(entry.isSymbolicLink())throw Error('发布源中不能包含符号链接');if(entry.isDirectory())await visit(path);else if(isProgramPath(path))paths.push(path);}}
 for(const folder of ['src','public','prompts','test'])await visit(folder);
 paths.push('docs/使用说明.md','docs/公开发布与自动更新.md','docs/更新说明_2026-11-11.md','docs/豆包更新指令.txt');
 const files=[];for(const path of paths.sort()){if((await lstat(join(root,path))).isSymbolicLink())throw Error('发布源中不能包含符号链接');const bytes=await readFile(join(root,path));files.push({path,content:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')});}
 const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
 const manifest={version,files};validateUpdateManifest(manifest);await mkdir(dirname(destination),{recursive:true});await writeFile(destination,JSON.stringify(manifest),{mode:0o644});return{version,files:files.length,destination};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const root=fileURLToPath(new URL('..',import.meta.url));console.log(JSON.stringify(await buildUpdate(root,resolve(process.argv[2]||join(root,'outputs/jingxu-update.json')))));}
