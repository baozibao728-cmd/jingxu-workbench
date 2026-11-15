export const imageModelPresets=[
 {id:'gpt-image-2.6',label:'GPT Image 2.6'},
 {id:'gpt-image-2',label:'Image2 · GPT Image 2'},
 {id:'gpt-image-2-vip',label:'GPT Image 2 VIP'},
 {id:'gpt-image-2.5',label:'GPT Image 2.5'},
 {id:'gpt-image-2.6-flare',label:'GPT Image 2.6 Flare'},
 {id:'gpt-image-2.6-sunburst',label:'GPT Image 2.6 Sunburst'},
];
const labels=new Map(imageModelPresets.map(m=>[m.id,m.label]));
export function normalizeModels(value,current=''){
 const source=typeof value==='string'?value.split(/\r?\n/).filter(x=>x.trim()):value??[];
 if(!Array.isArray(source)||source.length>100)throw Error('模型列表最多100项，每行一个型号');
 const items=[],seen=new Set();
 for(const entry of source){
  if(typeof entry!=='string'&&(!entry||typeof entry!=='object'||Array.isArray(entry)))throw Error('模型列表格式不正确');
  const parts=typeof entry==='string'?entry.split('|'):null;
  const rawId=parts?parts[0]:entry.id,rawLabel=parts?parts.slice(1).join('|'):entry.label;
  if(typeof rawId!=='string'||rawLabel!==undefined&&typeof rawLabel!=='string')throw Error('模型ID和名称需要填写文字');
  const id=rawId.trim(),label=(rawLabel||labels.get(id)||id).trim();
  if(!id||id.length>200||/[\r\n\t]/.test(id)||!label||label.length>120||/[\r\n]/.test(label))throw Error('每项需填写模型ID；可用“ID | 显示名称”，不要放入多行或过长内容');
  if(!seen.has(id)){seen.add(id);items.push({id,label});}
 }
 if(current&&!seen.has(current))items.unshift({id:current,label:labels.get(current)||current});
 if(items.length>100)throw Error('模型列表最多100项');return items;
}
export function providerModels(profile){return normalizeModels(profile.models??(profile.service==='grsai'&&(!profile.protocol||profile.protocol==='grsai')?imageModelPresets:[]),profile.model||'');}
export function modelLines(models){return models.map(m=>m.label===m.id?m.id:`${m.id} | ${m.label}`).join('\n');}
