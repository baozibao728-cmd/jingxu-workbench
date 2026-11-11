import {digest,now} from './project-store.js';
export function boundaryState(shot,side){
 if(shot.continuity?.[side])return shot.continuity[side];
 const text=shot.promptTemplate||'';
 if(side==='start'){const found=text.match(/本段起始状态[：:]\s*([^\n]+)/);if(found)return found[1].trim();}
 const matches=[...text.matchAll(/第\d+个镜头\[[^\]]+\][^\n]*/g)];
 if(matches.length)return(side==='start'?matches[0]:matches.at(-1))[0];
 return(side==='start'?'原条开场保持：':'原条收尾保持：')+text;
}
export function dialogueLines(text){return [...String(text).matchAll(/[：:]\s*[“"]([^”"\n]+)[”"]/g)].map(m=>m[1]);}
export function markFollowing(project,index,reason){
 for(let i=index;i<project.shots.length;i++){const shot=project.shots[i];shot.continuityReview={state:'required',reason,at:now()};}
}
export function normalizeSegmentNumbers(template,index){return String(template).replace(/^\{分镜\d+\}/m,`{分镜${index+1}}`);}
export function renumberSegments(project){project.shots.forEach((shot,index)=>{shot.promptTemplate=normalizeSegmentNumbers(shot.promptTemplate,index);});}
export function continuityHash(project){return digest(project.shots.map(shot=>({id:shot.id,prompt:shot.promptTemplate,duration:shot.duration})));}
