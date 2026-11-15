import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';

const execute = promisify(execFile);
const probe = async path => {
  try {
    const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', path], { timeout: 30000 });
    const info = JSON.parse(stdout);
    if (!info.streams.some(stream => stream.codec_type === 'video')) throw new Error();
    return info;
  } catch { throw new Error('无法读取视频信息，请确认已安装FFmpeg（含ffprobe），且所有片段可播放。'); }
};

export async function mergeVideos({ files, output, aspectRatio, temporaryRoot, onProgress = () => {} }) {
  if (!files.length) throw new Error('没有可以合成的视频');
  const metadata = [];
  for (const file of files) metadata.push(await probe(file));
  if (files.length === 1) {
    await copyFile(files[0], output);
    return { duration: Number(metadata[0].format.duration), clips: 1 };
  }
  const directory = await mkdtemp(join(temporaryRoot, 'merge-'));
  const [width, height] = aspectRatio === '9:16' ? [486, 864] : aspectRatio === '1:1' ? [640, 640] : [864, 486];
  try {
    const normalized = [];
    for (let index = 0; index < files.length; index++) {
      onProgress(`整理片段 ${index + 1} / ${files.length}`);
      const target = join(directory, `${index}.mp4`);
      const hasAudio = metadata[index].streams.some(stream => stream.codec_type === 'audio');
      const args = ['-hide_banner', '-loglevel', 'error', '-i', files[index]];
      if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
      args.push('-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0',
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', '-y', target);
      await execute('ffmpeg', args, { timeout: 10 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 });
      normalized.push(target);
    }
    onProgress('正在合成整集');
    const list = join(directory, 'inputs.txt');
    await writeFile(list, normalized.map(file => `file '${file.replaceAll("'", "'\\''")}'`).join('\n'));
    await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', '-y', output], { timeout: 10 * 60 * 1000 });
    const result = await probe(output);
    const expected = metadata.reduce((total, info) => total + Number(info.format.duration), 0);
    const actual = Number(result.format.duration);
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > Math.max(0.5, files.length * 0.2)) throw new Error('合成后的时长与片段总长不一致，未标记成功。');
    return { duration: actual, clips: files.length };
  } catch (error) {
    await rm(output, { force: true });
    throw new Error(error.message.startsWith('合成后') ? error.message : '视频合成失败，原始片段已保留。请检查FFmpeg安装和片段文件。');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
