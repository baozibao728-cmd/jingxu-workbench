import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PromptSettings, resolvePrompts} from '../src/prompt-settings.js';
import {splitScript} from '../src/script-chunks.js';
import {ProjectStore} from '../src/project-store.js';
import {Workflow} from '../src/workflow.js';

const settings={deepseek:{apiKey:'fake',model:'text'},grsai:{apiKey:'fake',model:'gpt-image-fake'},fydmai:{apiKey:'fake',model:'c7-wan3',baseUrl:'https://video.example'}};

test('五项提示词独立持久化，空白项和恢复默认使用内置规则',async()=>{
  const root=await mkdtemp(join(tmpdir(),'drama-prompts-'));
  try{
    const store=new PromptSettings(join(root,'prompts.json'));await store.init();
    const defaults=store.effective();
    assert.equal(Object.keys(defaults).length,5);
    await store.save({characters:'自定义角色规则',scenes:'  '});
    const reload=new PromptSettings(join(root,'prompts.json'));await reload.init();
    assert.equal(reload.effective().characters,'自定义角色规则');
    assert.equal(reload.effective().scenes,defaults.scenes);
    await reload.save({characters:''});
    assert.deepEqual(reload.effective(),defaults);
    await assert.rejects(reload.save({props:'a'.repeat(20001)}),/2万字/);
    assert.deepEqual(reload.effective(),defaults);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('长剧本分段保留全部原文与对白，不截断单场或无场景标题的长文本',()=>{
  for(const script of [
    '【人物小传】\n资料\n'+Array.from({length:55},(_,i)=>`场景${i+1}：[室内]\n角色：“十家药有九家可以变好。”\n`).join(''),
    '😀'.repeat(6000)+'\n完整结尾。',
    '场景一：[室内]\n'+('一整场动作和对白。\n'.repeat(1400)),
  ]){
    const chunks=splitScript(script);
    assert.equal(chunks.map(item=>item.text).join(''),script);
    assert.ok(chunks.every(item=>item.text.length<=5000));
  }
  const sections=splitScript('【人物小传】\n资料\n场景一：[内景]\n正文。');
  assert.equal(sections[0].referenceOnly,true);
  assert.equal(sections[1].referenceOnly,false);
});

test('45段剧本先列46项资产，勾选后只生1张图；分镜中断可续接且不会省略40条之后的内容',async()=>{
  const root=await mkdtemp(join(tmpdir(),'drama-long-'));
  const store=new ProjectStore(root);await store.init();
  let imageCalls=0,videoCalls=0,storyCalls=0,failOnce=true,customUsed=false;
  const project=await store.create({title:'长剧本测试',script:'【人物小传】\n主角资料\n'+Array.from({length:45},(_,i)=>`场景${i+1}：[内景]\n主角：“第${i+1}句原文。”\n`).join(''),clipDuration:15,resolution:'720p'});
  const workflow=new Workflow(store,()=>settings,{
    getPrompts:()=>resolvePrompts({characters:'仅提取当前段落出场人物，CUSTOM-RULE'}),intervalMs:1,
    factories:{
      text:()=>({generateJson:async({instructions,input})=>{
        const data=JSON.parse(input);
        if(data.chunk){
          customUsed ||= instructions.includes('CUSTOM-RULE');
          return {assets:[{key:'hero',kind:'character',name:'主角',prompt:'One adult person',description:'主角'},
            {key:`scene-${data.chunk.index}`,kind:'scene',name:`场景${data.chunk.index}`,prompt:'Empty room',description:'空景'}]};
        }
        storyCalls++;
        if(data.chunkIndex===24&&failOnce){failOnce=false;throw Error('模拟中断');}
        return {shots:[{title:data.chunkTitle,duration:15,promptTemplate:`{{ref:hero}} ${data.script}`} ]};
      }}),
      image:()=>({submit:async()=>{imageCalls++;return{id:'fake-image',status:'completed',urls:['https://example.com/fake.png']};}}),
      video:()=>({submit:async()=>{videoCalls++;throw Error('不应提交视频');}}),
    },download:async(url,path)=>{await writeFile(path,'fake-image');},
  });
  try{
    await workflow.startPreparation(project.id);await workflow.active.get(`prepare:${project.id}`);
    assert.equal(project.preparation.phase,'asset-list');
    assert.equal(project.assets.length,46);assert.equal(customUsed,true);
    assert.equal(imageCalls,0);assert.equal(videoCalls,0);assert.equal(project.shots.length,0);
    const hero=project.assets.find(asset=>asset.sourceKey==='hero');
    await workflow.startAssetGeneration(project.id,[hero.id]);await workflow.active.get(`prepare:${project.id}`);
    assert.equal(project.preparation.state,'failed');assert.equal(imageCalls,1);
    assert.throws(()=>workflow.review(project.id,project.shots.map(shot=>shot.id)),/全部分镜/);
    await workflow.startAssetGeneration(project.id,[hero.id]);await workflow.active.get(`prepare:${project.id}`);
    assert.equal(project.preparation.state,'completed');assert.equal(imageCalls,1);assert.equal(videoCalls,0);
    assert.equal(project.shots.length,45);assert.equal(storyCalls,46);
    assert.ok(project.shots.every(shot=>shot.assetIds.length===1&&shot.assetIds[0]===hero.id));
    assert.equal(project.assets.filter(asset=>asset.image).length,1);
    const allPrompts=project.shots.map(shot=>shot.promptTemplate).join('\n');
    for(let i=1;i<=45;i++)assert.ok(allPrompts.includes(`第${i}句原文。`));
    const review=workflow.review(project.id,project.shots.map(shot=>shot.id));
    assert.equal(review.shots.length,45);assert.equal(review.totalSeconds,675);
  }finally{workflow.stopping=true;await Promise.allSettled([...workflow.active.values()]);await rm(root,{recursive:true,force:true});}
});

test('未提取出资产的项目修改原文后丢弃旧分段，不能继续分析旧剧本',async()=>{
  const root=await mkdtemp(join(tmpdir(),'drama-revise-'));
  try{
    const store=new ProjectStore(root);await store.init();
    const p=await store.create({script:'场景一：旧剧本'});
    p.chunks=splitScript(p.script);p.analysisPrompts=resolvePrompts();
    const workflow=new Workflow(store,()=>settings);
    await workflow.updateProject(p.id,{script:'场景一：全新剧本'});
    assert.equal(p.chunks,undefined);assert.equal(p.analysisPrompts,undefined);
    assert.equal(p.script,'场景一：全新剧本');
  }finally{await rm(root,{recursive:true,force:true});}
});
