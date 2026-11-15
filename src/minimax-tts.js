import { ApiClient } from './http.js';

export const MINIMAX_VOICE_MODELS = ['speech-2.8-hd','speech-2.8-turbo','speech-2.6-hd','speech-2.6-turbo','speech-02-hd','speech-02-turbo','speech-01-hd','speech-01-turbo'];

export class MiniMaxTTSProvider {
  constructor(config = {}) {
    this.config = { baseUrl: 'https://api.minimax.cn', ...config };
    this.client = new ApiClient(this.config);
  }
  async synthesize({ text, model = 'speech-2.8-hd', voiceId = 'male-qn-qingse', speed = 1, vol = 1, pitch = 0, emotion = '', format = 'mp3', languageBoost = 'auto', pronunciation = '' }) {
    if (!this.config.apiKey) throw new Error('请先配置 MiniMax 语音 API Key');
    const body = {
      model, text: String(text || '').slice(0, 9999), stream: false, output_format: 'hex', subtitle_enable: false,
      voice_setting: { voice_id: voiceId, speed: Number(speed), vol: Number(vol), pitch: Number(pitch), ...(emotion ? { emotion } : {}) },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format, channel: 1 },
      ...(languageBoost ? { language_boost: languageBoost } : {}),
      ...(pronunciation ? { pronunciation_dict: { tone: String(pronunciation).split(/\r?\n|,/).map(v => v.trim()).filter(Boolean) } } : {}),
    };
    const response = await this.client.request('/v1/t2a_v2', { method: 'POST', json: body });
    const base = response.base_resp;
    if (base && Number(base.status_code) !== 0) {
      const message = String(base.status_msg || '');
      if (/insufficient\s*balance|余额不足|balance/i.test(message)) throw Object.assign(new Error('MiniMax 账户余额不足，请充值或换一个有额度的 API Key 后再生成。'), { code: 'MINIMAX_INSUFFICIENT_BALANCE', providerMessage: message });
      throw new Error(message || `MiniMax 返回错误 ${base.status_code}`);
    }
    const hex = response.data?.audio;
    if (!hex || !/^[0-9a-f]+$/i.test(hex)) throw new Error('MiniMax 未返回有效音频');
    return { bytes: Buffer.from(hex, 'hex'), format, model, voiceId, meta: response.extra_info || {}, traceId: response.trace_id || '' };
  }
}
