// Defaults verified against the provider's /caps response. Live capabilities win.
const presets = {
  'c7-wan3': { minDuration: 15, maxDuration: 30, defaultDuration: 15, resolutions: ['720p', '1080p'], defaultResolution: '720p', maxReference: 20 },
  'seedance2.0': { minDuration: 4, maxDuration: 15, defaultDuration: 5, resolutions: ['480p'], defaultResolution: '480p', maxReference: 9 },
};

export function videoProfile(model, capabilities) {
  const live = capabilities?.models?.find(item => item.model === model && item.kind === 'video');
  const profile = { ...presets[model], ...live, model };
  if (!profile.resolutions?.length || !Number.isFinite(profile.minDuration) || !Number.isFinite(profile.maxDuration)) return {model,unavailable:true,error:`未获取到 ${model} 的视频参数，请在设置中刷新已保存的视频方案参数`,minDuration:1,maxDuration:30,defaultDuration:15,resolutions:['未获取'],defaultResolution:'未获取',maxReference:9};
  profile.defaultDuration ||= profile.minDuration;
  profile.defaultResolution ||= profile.resolutions[0];
  return profile;
}

export function validateVideoSettings(profile, duration, resolution) {
  if(profile.unavailable)throw new Error(profile.error);
  if (duration !== undefined && (!Number.isInteger(Number(duration)) || Number(duration) < profile.minDuration || Number(duration) > profile.maxDuration)) {
    throw new Error(`${profile.model} 每段支持 ${profile.minDuration}～${profile.maxDuration} 秒，请调整分镜时长和提示词`);
  }
  if (resolution !== undefined && !profile.resolutions.includes(resolution)) throw new Error(`${profile.model} 支持 ${profile.resolutions.join(' / ')}，请修改分辨率`);
}

// 从分镜提示词的时间戳（如 [0s-5.1s]…[27.1s-30.0s]、00-07秒、全程28秒、【预计总时长】30秒）自动识别所需秒数。
export function detectPromptDuration(text, profile = null) {
  const source = String(text || '').replace(/\{\{ref:[^}]+\}\}/g, ' ').replace(/@[^\s@，。！？；：,!?;:()（）]+/g, ' ');
  if (!source.trim()) return null;
  let explicit = 0, maxEnd = 0;
  for (const match of source.matchAll(/(?:【\s*(?:预计)?(?:总)?时长\s*】|(?:预计)?总时长|全片时长|视频时长|本镜时长|全程)\s*[】\]：:约为是]*\s*(\d{1,3}(?:\.\d+)?)\s*(?:秒|s\b)/gi)) {
    const val = Number(match[1]);
    if (val > 0 && val <= 180) explicit = Math.max(explicit, val);
  }
  for (const match of source.matchAll(/(?:\[\s*|\b)(\d{1,3}(?:\.\d+)?)\s*(?:s|秒)?\s*(?:[-–—~～]+|至|到)\s*(\d{1,3}(?:\.\d+)?)\s*(?:s|秒)(?:\s*\])?/gi)) {
    const start = Number(match[1]), end = Number(match[2]);
    if (end > start && start >= 0 && end <= 180) maxEnd = Math.max(maxEnd, end);
  }
  for (const match of source.matchAll(/\b(\d{1,2}):(\d{2})\s*(?:[-–—~～]+|至|到)\s*(\d{1,2}):(\d{2})\b/g)) {
    const start = Number(match[1]) * 60 + Number(match[2]), end = Number(match[3]) * 60 + Number(match[4]);
    if (end > start && start >= 0 && end <= 180) maxEnd = Math.max(maxEnd, end);
  }
  const raw = Math.max(explicit, maxEnd);
  if (!(raw > 0)) return null;
  const seconds = Math.max(1, Math.ceil(raw - 1e-6));
  if (profile && !profile.unavailable && Number.isFinite(profile.minDuration) && Number.isFinite(profile.maxDuration)) {
    return Math.max(profile.minDuration, Math.min(profile.maxDuration, seconds));
  }
  return seconds;
}
