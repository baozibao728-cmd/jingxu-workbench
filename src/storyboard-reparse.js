import {randomUUID} from 'node:crypto';
import {digest,now,jobActive} from './project-store.js';
import {splitScript} from './script-chunks.js';
import {renumberSegments} from './continuity.js';
import {validateVideoSettings} from './video-profile.js';

function sourceHash(project){return digest({script:project.script,style:project.style,aspectRatio:project.aspectRatio,ruleNotes:project.ruleNotes,shots:project.shots,assets:project.assets.map(a=>({id:a.id,name:a.name,sourceKey:a.sourceKey,kind:a.kind,description:a.description,selected:a.selected,image:a.image?.sha256}))});}
export function reparseSummary(record){if(!record)return undefined;const {draft,...summary}=record;return {...summary,generated: draft?.shots.length??record.generated??0,completed:draft?.chunks.filter(c=>c.storyboardState==='completed'||c.referenceOnly).length??record.completed??0,total:draft?.chunks.length??record.total??0,canResume:record.state==='failed'&&!!draft};}
export async function startStoryboardReparse(workflow,id,input={}){
 const project=workflow.store.get(id);workflow.assertEditable(project);
 if(jobActive(project.mergeJob))throw Error('整集正在合成，请完成后再重新解析');
 if(project.shots.some(s=>s.job?.state==='unknown'||(s.job?.taskId&&s.job.state!=='completed'&&!s.video)))throw Error('有视频任务结果未知或尚未接收，请先查询完成再全部重新解析');
 if(!project.script.trim())throw Error('请先填写剧本');
 if(!workflow.config().deepseek.apiKey)throw Error('请先配置文本服务');
 const selected=project.assets.filter(a=>a.selected!==false);if(!selected.length||selected.some(a=>!a.image))throw Error('请先完成选中资产的图片，再重新解析全部分镜');
 const hash=sourceHash(project);let record;
 if(input.resume===true){
  record=project.storyboardReparse;
  if(record?.state!=='failed'||!record.draft)throw Error('没有可继续的全部解析任务');
  if(record.sourceHash!==hash)throw Error('剧本、分镜或资产已更改，请从头全部重新解析');
 }else{
  const duration=Number(input.duration??project.clipDuration);validateVideoSettings(workflow.videoProfile(),duration,workflow.resolution(project));
  if(input.notes!==undefined&&(typeof input.notes!=='string'||input.notes.length>6000))throw Error('本次调整要求最多6000字');
  const chunks=project.chunks?.length?structuredClone(project.chunks):splitScript(project.script);
  if(!chunks.some(c=>!c.referenceOnly))throw Error('剧本没有可生成分镜的正文');
  chunks.forEach(c=>c.storyboardState='idle');
  if(project.storyboardReparse?.draft)(project.storyboardHistory||=[]).push({at:now(),reason:'未完成的全部解析草稿',draft:structuredClone(project.storyboardReparse)});
  record={id:randomUUID(),state:'running',at:now(),duration,resolution:workflow.resolution(project),notes:String(input.notes||'').trim(),sourceHash:hash,draft:{shots:[],chunks,storyboardPrompts:structuredClone(workflow.getPrompts())}};
  project.storyboardReparse=record;
 }
 validateVideoSettings(workflow.videoProfile(),record.duration,record.resolution);
 record.state='running';delete record.error;
 project.preparation={state:'running',phase:'reparse-storyboards',stage:'全部分镜重新解析；旧分镜保留至完成',completed:0,total:record.draft.chunks.length};
 workflow.store.log(project,'开始全部重新解析分镜，复用已有图片；仅生成文字，不自动生成视频。');await workflow.store.save(project);
 await workflow.launch(`reparse:${id}`,async()=>{
  try{
   const work={id:project.id,title:project.title,script:project.script,style:project.style,aspectRatio:project.aspectRatio,ruleNotes:[project.ruleNotes,record.notes&&`本次全部重解析要求：${record.notes}`].filter(Boolean).join('\n'),clipDuration:record.duration,resolution:record.resolution,assets:structuredClone(project.assets),shots:record.draft.shots,chunks:record.draft.chunks,storyboardPrompts:record.draft.storyboardPrompts,revision:project.revision,preparation:{state:'running'},logs:[]};
   await workflow.generateStoryboards(work,{promptRules:record.draft.storyboardPrompts,checkpoint:async()=>{
    record.draft={shots:work.shots,chunks:work.chunks,storyboardPrompts:work.storyboardPrompts};
    const completed=work.chunks.filter(c=>c.referenceOnly||c.storyboardState==='completed').length;
    project.preparation={state:'running',phase:'reparse-storyboards',stage:`全部重新解析 · ${work.preparation.stage} · 草稿${work.shots.length}条，旧分镜保留`,completed,total:work.chunks.length};await workflow.store.save(project);
   }});
   if(workflow.stopping)return;
   if(sourceHash(project)!==record.sourceHash)throw Error('解析期间剧本或素材已变化，旧分镜保留，请从头重试');
   if(!work.shots.length||work.chunks.some(c=>!c.referenceOnly&&c.storyboardState!=='completed'))throw Error('全部分镜尚未解析完成，旧分镜保留');
   (project.storyboardHistory||=[]).push({at:now(),reason:'全部重新解析分镜',originals:structuredClone(project.shots),chunks:structuredClone(project.chunks||[]),mergedVideo:structuredClone(project.mergedVideo),storyboardPrompts:structuredClone(project.storyboardPrompts),clipDuration:project.clipDuration,resolution:project.resolution});
   project.shots=work.shots;project.chunks=work.chunks;project.storyboardPrompts=work.storyboardPrompts;project.clipDuration=record.duration;project.resolution=record.resolution;delete project.mergedVideo;renumberSegments(project);project.revision++;
   record.state='completed';record.finishedAt=now();record.generated=work.shots.length;record.completed=work.chunks.length;record.total=work.chunks.length;delete record.draft;
   project.preparation={state:'completed',phase:'review',stage:`全部重新解析完成，共${project.shots.length}条，等待你检查后生成视频`,completed:work.chunks.length,total:work.chunks.length};workflow.store.log(project,`全部重解析完成：${project.shots.length}条分镜；旧版本与成片保留，没有提交图片或视频。`);
  }catch(error){record.state='failed';record.error=workflow.errorText(error);project.preparation={...project.preparation,state:'failed',phase:'reparse-storyboards',error:record.error};workflow.store.log(project,`全部重新解析中断：${record.error}。旧分镜保留，可继续未完成的段落。`,'error');}
  await workflow.store.save(project);
 });return workflow.view(project);
}
