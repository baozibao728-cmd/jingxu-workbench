export function readConfig(env = process.env) {
  return {
    deepseek: {
      baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      apiKey: env.DEEPSEEK_API_KEY || '',
      model: env.DEEPSEEK_MODEL || 'deepseek-flash',
    },
    grsai: {
      baseUrl: env.GRSAI_BASE_URL || 'https://grsaiapi.com',
      apiKey: env.GRSAI_API_KEY || '',
      model: env.GRSAI_IMAGE_MODEL || 'gpt-image-2.6',
    },
    fydmai: {
      baseUrl: env.FYDMAI_BASE_URL || 'https://fydmai.com',
      apiKey: env.FYDMAI_API_KEY || '',
      model: env.FYDMAI_VIDEO_MODEL || 'c7-wan3',
    },
    minimax: {
      baseUrl: env.MINIMAX_BASE_URL || 'https://api.minimax.cn',
      apiKey: env.MINIMAX_API_KEY || '',
      model: env.MINIMAX_TTS_MODEL || 'speech-2.8-hd',
    },
  };
}
