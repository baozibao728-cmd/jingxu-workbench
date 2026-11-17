// 画布里的音视频处理：上传整理、分离音视频、截取音频。都交给本机的 FFmpeg。
import { rm } from 'node:fs/promises';
import { ffmpegTools } from './ffmpeg-tools.js';

const LONG = { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 };
// 没装 FFmpeg 时 ffmpegTools 会自动下载；装不上就把原因告诉用户。
const reason = (error, fallback) => error?.install ? error.message : error?.code === 'ENOENT' ? 'FFmpeg 无法运行，请重启工作台后再试' : fallback;

export async function probeMedia(path) {
  let stdout;
  try { ({ stdout } = await ffmpegTools.run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration,format_name', '-of', 'json', path], { timeout: 30000 })); }
  catch (error) { throw new Error(reason(error, '读不出这个文件，请确认是能正常播放的音频或视频')); }
  const info = JSON.parse(stdout), streams = info.streams || [];
  const video = streams.find(stream => stream.codec_type === 'video' && !['mjpeg', 'png'].includes(stream.codec_name));
  const audio = streams.find(stream => stream.codec_type === 'audio');
  return { video, audio, duration: Number(info.format?.duration) || 0, format: String(info.format?.format_name || '') };
}

async function ffmpeg(args, output) {
  try { await ffmpegTools.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, '-y', output], LONG); }
  catch (error) { await rm(output, { force: true }); throw new Error(reason(error, '音视频处理失败，原文件没有改动')); }
}

// 上传的文件整理成浏览器一定能放的格式：视频 mp4，音频 mp3 原样保留，其余转成 m4a。
export async function normalizeUpload(input, outputBase) {
  const info = await probeMedia(input);
  if (info.video) {
    const output = `${outputBase}.mp4`;
    try { await ffmpeg(['-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart'], output); }
    catch { await ffmpeg(['-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'], output); }
    return { kind: 'video', output, ...(await probeMedia(output)) };
  }
  if (!info.audio) throw new Error('只支持图片、音频和视频文件');
  if (info.audio.codec_name === 'mp3' && /mp3/.test(info.format)) {
    const output = `${outputBase}.mp3`;
    await ffmpeg(['-i', input, '-map', '0:a:0', '-c', 'copy'], output);
    return { kind: 'audio', output, ...(await probeMedia(output)) };
  }
  const output = `${outputBase}.m4a`;
  await ffmpeg(['-i', input, '-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k'], output);
  return { kind: 'audio', output, ...(await probeMedia(output)) };
}

// 分离音视频：得到一个没有声音的视频和一段音轨，原视频不动。
export async function splitMedia(input, videoBase, audioBase) {
  const info = await probeMedia(input);
  if (!info.video) throw new Error('这不是视频，没有可分离的画面');
  if (!info.audio) throw new Error('这个视频没有声音，不用分离');
  const video = `${videoBase}.mp4`, audio = `${audioBase}.m4a`;
  await ffmpeg(['-i', input, '-map', '0:v:0', '-an', '-c:v', 'copy', '-movflags', '+faststart'], video);
  try {
    if (info.audio.codec_name === 'aac') await ffmpeg(['-i', input, '-map', '0:a:0', '-vn', '-c:a', 'copy'], audio);
    else await ffmpeg(['-i', input, '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '192k'], audio);
  } catch (error) { await rm(video, { force: true }); throw error; }
  return { video: { output: video, ...(await probeMedia(video)) }, audio: { output: audio, ...(await probeMedia(audio)) } };
}

// 截取一段音频：按秒，重新编码，保证切点准确。
export async function trimAudio(input, start, end, outputBase) {
  const info = await probeMedia(input);
  if (!info.audio) throw new Error('这个文件没有声音，不能截取');
  const from = Number(start), to = Number(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to - from < 0.1) throw new Error('截取的时间段不对，至少要 0.1 秒');
  if (info.duration && to > info.duration + 0.05) throw new Error('截取的结束时间超过了音频长度');
  const output = `${outputBase}.m4a`;
  await ffmpeg(['-ss', from.toFixed(3), '-i', input, '-t', (to - from).toFixed(3), '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '192k'], output);
  return { output, ...(await probeMedia(output)) };
}
