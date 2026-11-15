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
