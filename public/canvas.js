// 画布：在一张无限大的画面上摆放图片和视频节点，用连线把图片当参考图接到生成节点上。
// 生成本身走“自由创作”的同一套接口；选中生成节点时，下方的输入框也是同一个，只是内容换成这个节点的。
import { draft, setHost, composerBox, paint, removeRef as dropRef, removeAudio as dropAudio, settle, loadData, studioData, onData, mediaHTML, activeJob } from './studio.js';

let ctx = null, list = [], cv = null, root = null, bound = null, drag = null, space = false, saveTimer = null, menuState = null, trim = null, edgeTimer = 0;
const sel = new Set(), last = { x: 0, y: 0 };
const LABEL = 26, BLANK = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E';
const $ = selector => root?.querySelector(selector);
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), byte => 'abcdefghijklmnopqrstuvwxyz0123456789'[byte % 36]).join('');
const node = id => cv.nodes.find(item => item.id === id);
const height = item => item.w / (item.ratio || 16 / 9);
const sources = target => cv.edges.filter(edge => edge.to === target.id).map(edge => node(edge.from)).filter(Boolean);
const imageSources = target => sources(target).filter(item => item.type === 'image');
const audioSources = target => target.type === 'video' ? sources(target).filter(item => item.type === 'audio') : [];
// 能拉线出去的：图片当参考图，音频当参考音频（只能接视频生成）。
const linkable = item => item?.type === 'image' || item?.type === 'audio';
const fits = (from, target) => target?.source === 'gen' && from && from.id !== target.id && (from.type === 'image' || (from.type === 'audio' && target.type === 'video'));
const itemOf = item => item.itemId ? studioData()?.items.find(entry => entry.id === item.itemId) : null;
const toWorld = (clientX, clientY) => ({ x: (clientX - cv.view.x) / cv.view.k, y: (clientY - cv.view.y) / cv.view.k });
const ratioOf = text => ({ '9:16': 9 / 16, '1:1': 1 }[text] || 16 / 9);
const AUDIO = 320 / 112;
// 节点能拿来预览、下载的文件：上传的素材直接有地址，生成节点等成片回来。
const mediaUrl = item => item.url || itemOf(item)?.result?.url || '';
const clock = seconds => { const value = Math.max(0, Number(seconds) || 0), m = Math.floor(value / 60), sec = value - m * 60; return `${String(m).padStart(2, '0')}:${sec < 10 ? '0' : ''}${sec.toFixed(value < 60 && value % 1 ? 1 : 0)}`.replace(/\.0$/, ''); };
const nodeIcon = type => type === 'video' ? 'play' : type === 'audio' ? 'wave' : 'image';

export function initCanvas(context) { ctx = context; onData(updateNodes); }
export async function loadList() { list = await ctx.api('/api/studio/canvases'); }
export function listHTML() {
  const { escape, icon } = ctx, date = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `<div class="studio-canvas"><button class="studio-canvas-card new" data-action="canvas-new"><span class="studio-canvas-plus">${icon('plus', 18)}</span><strong>新建画布</strong></button>${list.map(item => `<div class="studio-canvas-card" role="button" tabindex="0" data-action="canvas-open" data-id="${escape(item.id)}"><div class="studio-canvas-thumbs">${item.thumbs.map(url => `<img src="${escape(url)}" alt="" loading="lazy">`).join('')}</div><div class="studio-canvas-info"><strong>${escape(item.title)}</strong><small>${item.count} 个节点 · ${date(item.updatedAt)}</small></div><button class="small ghost icon-button studio-canvas-delete" data-action="canvas-delete" data-id="${escape(item.id)}" title="删除这张画布">${icon('trash', 14)}</button></div>`).join('')}</div>`;
}
const refreshList = async () => { await loadList(); const stage = document.querySelector('.studio-stage'); if (stage?.querySelector('.studio-canvas')) stage.innerHTML = listHTML(); };

// ---- 保存 ----
function save(soon = true) {
  clearTimeout(saveTimer); if (!cv) return;
  const push = () => { const current = cv; if (current) ctx.api(`/api/studio/canvases/${current.id}`, { method: 'PATCH', body: { title: current.title, view: current.view, nodes: current.nodes, edges: current.edges, groups: current.groups } }).catch(error => ctx.notify(`画布没保存上：${error.message}`, true)); };
  if (soon) saveTimer = setTimeout(push, 500); else return push();
}

// ---- 画面 ----
function applyView(animate = false) {
  const world = $('.cv-world'), { x, y, k } = cv.view;
  if (animate && !calm()) { world.classList.add('cv-anim'); setTimeout(() => world.classList.remove('cv-anim'), 320); }
  world.style.transform = `translate(${x}px,${y}px) scale(${k})`;
  root.style.backgroundPosition = `${x}px ${y}px`; root.style.backgroundSize = `${24 * k}px ${24 * k}px`;
  $('.cv-zoom output').textContent = `${Math.round(k * 100)}%`; if (sel.size > 1) drawSelBox(); drawNodeBar();
  placePanel(animate);
}
function zoomAt(next, clientX = innerWidth / 2, clientY = innerHeight / 2, animate = false) {
  const k = Math.min(3, Math.max(.1, next)), view = cv.view;
  view.x = clientX - (clientX - view.x) * k / view.k; view.y = clientY - (clientY - view.y) * k / view.k; view.k = k; applyView(animate); save();
}
function fit() {
  if (!cv.nodes.length) { cv.view = { x: innerWidth / 2, y: innerHeight / 2, k: 1 }; return applyView(true); }
  const left = Math.min(...cv.nodes.map(item => item.x)), top = Math.min(...cv.nodes.map(item => item.y)), right = Math.max(...cv.nodes.map(item => item.x + item.w)), bottom = Math.max(...cv.nodes.map(item => item.y + LABEL + height(item)));
  const k = Math.min(1, Math.max(.1, Math.min((innerWidth - 240) / (right - left), (innerHeight - 300) / (bottom - top))));
  cv.view = { k, x: innerWidth / 2 - (left + right) / 2 * k, y: innerHeight / 2 - (top + bottom) / 2 * k - 40 }; applyView(true); save();
}
function audioHTML(item) {
  const { escape, icon } = ctx, bars = peaks.get(item.url);
  return `<div class="cv-audio"><div class="cv-wave">${waveHTML(bars)}<i class="cv-playhead" data-seek title="拖动换位置"></i>${trim?.id === item.id ? trimHTML(item) : ''}</div><div class="cv-audio-bar"><span class="cv-time">00:00</span><button class="cv-play" data-play aria-label="播放">${icon('play', 12)}</button><span>${clock(item.duration)}</span></div><audio src="${escape(item.url)}" preload="metadata"></audio></div>`;
}
function bodyHTML(item) {
  const { escape, icon } = ctx;
  if (item.type === 'audio') return audioHTML(item);
  if (item.type === 'video' && item.url) return `<video src="${escape(item.url)}" controls preload="metadata" playsinline></video>`;
  if (item.source === 'upload') return `<img src="${escape(item.url || BLANK)}" alt="" draggable="false">`;
  const job = itemOf(item);
  if (job) return mediaHTML(job).replace(' data-zoom-image', '').replace(' tabindex="0"', '');
  if (item.url) return `<img src="${escape(item.url)}" alt="" draggable="false">`;
  return `<div class="cv-blank">${icon(item.type === 'video' ? 'play' : 'image', 30)}</div>`;
}
const bodyKey = item => { const job = itemOf(item); return JSON.stringify([item.url, job?.result?.url || '', job?.job.state || '', job?.job.error || '', item.type === 'audio' && trim?.id === item.id]); };
function nodeHTML(item, fresh = false) {
  const { escape, icon } = ctx;
  return `<div class="cv-node type-${item.type} ${sel.has(item.id) ? 'selected' : ''} ${fresh ? 'is-new' : ''}" data-node="${item.id}" style="left:${item.x}px;top:${item.y}px;width:${item.w}px"><div class="cv-node-label">${icon(nodeIcon(item.type), 12)}<span>${escape(item.label)}</span>${item.duration && item.type !== 'image' ? `<em>${clock(item.duration)}</em>` : ''}</div><div class="cv-node-body" data-key="${escape(bodyKey(item))}" style="aspect-ratio:${item.ratio || 16 / 9}">${bodyHTML(item)}</div>${trim?.id === item.id ? trimBarHTML() : ''}${linkable(item) ? `<button class="cv-handle" data-handle title="${item.type === 'audio' ? '拉出连线，给视频当参考音频' : '拉出连线，用这张图去生成'}" aria-label="拉出连线"><i>${icon('plus', 13)}</i></button>` : ''}</div>`;
}
function drawNodes() { $('.cv-nodes').innerHTML = cv.nodes.map(item => nodeHTML(item)).join(''); drawEdges(); drawGroups(); toggleEmpty(); }
function toggleEmpty() { $('.cv-empty').hidden = cv.nodes.length > 0; }
const anchorOut = item => ({ x: item.x + item.w, y: item.y + LABEL + height(item) / 2 });
const anchorIn = item => ({ x: item.x, y: item.y + LABEL + height(item) / 2 });
const curve = (a, b) => { const bend = Math.max(60, Math.abs(b.x - a.x) / 2); return `M${a.x},${a.y} C${a.x + bend},${a.y} ${b.x - bend},${b.y} ${b.x},${b.y}`; };
// 流光分三层：长尾、光身、最前面的亮头，三层同速，看起来像一股往前跑的电流。
const flow = (d, fast = false) => ['tail', 'body', 'head'].map(part => `<path class="flow ${part}${fast ? ' fast' : ''}" d="${d}"/>`).join('');
const tempEdges = (from, to) => from.filter(node).map(id => { const d = curve(anchorOut(node(id)), to); return `<path class="lit" d="${d}"/>${flow(d)}`; }).join('');
function drawEdges() {
  // 正在拉的线、松手后等着选类型的线，都从状态里重画，别的地方刷新时不会把它冲掉。
  const pending = drag?.kind === 'link' && drag.to ? tempEdges(drag.from, drag.to) : menuState?.from ? tempEdges(menuState.from, menuState.world) : '';
  const svg = $('.cv-edges');
  // 每次重画都按同一个时钟对齐动画进度，流光不会因为重画而跳回起点。
  svg.style.setProperty('--cv-t', `${-(performance.now() % 10400)}ms`);
  svg.innerHTML = cv.edges.map(edge => { const from = node(edge.from), to = node(edge.to); if (!from || !to) return ''; const busy = activeJob(itemOf(to)?.job), lit = sel.has(from.id) || sel.has(to.id); const d = curve(anchorOut(from), anchorIn(to)); return `<path class="${lit ? 'lit' : ''}" d="${d}"/>${busy || lit ? flow(d, busy) : ''}`; }).join('') + pending;
}
// ---- 音频：波形、播放、截取 ----
const peaks = new Map(), loading = new Map();
function waveHTML(bars) {
  const values = bars || Array.from({ length: 64 }, () => .08);
  return `<svg viewBox="0 0 ${values.length * 3} 40" preserveAspectRatio="none" aria-hidden="true">${values.map((value, index) => { const h = Math.max(1.5, value * 36); return `<rect x="${index * 3 + .6}" y="${20 - h / 2}" width="1.8" height="${h}" rx=".9"/>`; }).join('')}</svg>`;
}
async function loadPeaks(url) {
  if (peaks.has(url)) return peaks.get(url);
  if (!loading.has(url)) loading.set(url, (async () => {
    const buffer = await (await fetch(url)).arrayBuffer(), context = new OfflineAudioContext(1, 1, 44100);
    const audio = await context.decodeAudioData(buffer), data = audio.getChannelData(0), count = 72, step = Math.max(1, Math.floor(data.length / count)), out = [];
    for (let bar = 0; bar < count; bar++) { let max = 0; for (let i = bar * step, end = Math.min(data.length, i + step); i < end; i += 16) max = Math.max(max, Math.abs(data[i])); out.push(max); }
    const top = Math.max(...out) || 1, result = out.map(value => Math.pow(value / top, .8)); peaks.set(url, result); return result;
  })().catch(() => null).finally(() => loading.delete(url)));
  return loading.get(url);
}
function watchAudio(scope, item) {
  const audio = scope.querySelector('audio'); if (!audio) return;
  loadPeaks(item.url).then(bars => { if (!bars) return; for (const element of root?.querySelectorAll(`[data-node] .cv-audio`) || []) { const owner = node(element.closest('[data-node]').dataset.node); if (owner?.url === item.url) element.querySelector('.cv-wave svg').outerHTML = waveHTML(bars); } });
  const head = scope.querySelector('.cv-playhead'), time = scope.querySelector('.cv-time'), button = scope.querySelector('[data-play]');
  let frame = 0;
  const show = () => { const total = audio.duration || item.duration || 1; head.style.setProperty('--p', Math.min(1, audio.currentTime / total)); time.textContent = clock(audio.currentTime);
    if (trim?.id === item.id && audio.currentTime >= trim.end) { audio.pause(); audio.currentTime = trim.start; }
    if (!audio.paused) frame = requestAnimationFrame(show); };
  audio.addEventListener('play', () => { button.innerHTML = ctx.icon('pause', 12); button.ariaLabel = '暂停'; scope.closest('.cv-node')?.classList.add('playing'); cancelAnimationFrame(frame); frame = requestAnimationFrame(show); });
  audio.addEventListener('pause', () => { button.innerHTML = ctx.icon('play', 12); button.ariaLabel = '播放'; scope.closest('.cv-node')?.classList.remove('playing'); cancelAnimationFrame(frame); show(); });
  audio.addEventListener('timeupdate', () => { if (audio.paused) show(); });
  audio.addEventListener('loadedmetadata', () => { if (!item.duration && audio.duration) { item.duration = Math.round(audio.duration * 1000) / 1000; scope.querySelector('.cv-audio-bar span:last-child').textContent = clock(item.duration); save(); } });
}
// 拖红线或点波形：跳到那个位置，正在播就接着播。
function seekTo(element, clientX) {
  const audio = element.querySelector('audio'), wave = element.querySelector('.cv-wave'), item = node(element.dataset.node); if (!audio || !wave || !item) return;
  const rect = wave.getBoundingClientRect(), pad = 8 * rect.width / wave.offsetWidth, total = audio.duration || item.duration || 0; if (!total) return;
  const fraction = Math.min(1, Math.max(0, (clientX - rect.left - pad) / (rect.width - pad * 2)));
  audio.currentTime = fraction * total; element.querySelector('.cv-playhead').style.setProperty('--p', fraction); element.querySelector('.cv-time').textContent = clock(fraction * total);
}
function togglePlay(element) {
  const audio = element.querySelector('audio'), item = node(element.dataset.node); if (!audio) return;
  for (const other of root.querySelectorAll('.cv-node audio')) if (other !== audio && !other.paused) other.pause();
  if (!audio.paused) return audio.pause();
  if (trim?.id === item.id && (audio.currentTime < trim.start || audio.currentTime >= trim.end - .05)) audio.currentTime = trim.start;
  audio.play().catch(() => ctx.notify('这段音频放不出来', true));
}
const trimHTML = item => { const total = item.duration || 1, left = trim.start / total * 100, right = trim.end / total * 100;
  return `<div class="cv-trim"><i class="cv-trim-mask" style="left:0;width:${left}%"></i><div class="cv-trim-window" data-trim="body" style="left:${left}%;width:${right - left}%"><b data-trim="l"></b><span>${(trim.end - trim.start).toFixed(trim.end - trim.start < 10 ? 1 : 0)} s</span><b data-trim="r"></b></div><i class="cv-trim-mask" style="left:${right}%;right:0"></i></div>`; };
const trimBarHTML = () => `<div class="cv-trimbar"><button data-action="canvas-trim-cancel" aria-label="取消截取">${ctx.icon('close', 14)}</button><strong>截取</strong><output>${clock(trim.start)} - ${clock(trim.end)}</output><button class="cv-trim-run" data-action="canvas-trim-run">生成</button></div>`;
function paintTrim() {
  const element = trim && root?.querySelector(`[data-node="${trim.id}"]`), item = trim && node(trim.id); if (!element || !item) return;
  const holder = element.querySelector('.cv-trim'); if (holder) holder.outerHTML = trimHTML(item);
  const output = element.querySelector('.cv-trimbar output'); if (output) output.textContent = `${clock(trim.start)} - ${clock(trim.end)}`;
}
function startTrim(item) {
  const total = item.duration || root.querySelector(`[data-node="${item.id}"] audio`)?.duration || 0;
  if (!total) return ctx.notify('音频还没读出长度，稍等再试', true);
  item.duration ||= total; trim = { id: item.id, start: 0, end: Math.min(total, 10), busy: false }; refreshNode(item);
}
function endTrim() { const item = trim && node(trim.id); trim = null; if (item) refreshNode(item); }
// 整个节点重画（截取开关、上传后的素材替换）。
function refreshNode(item) {
  const element = root?.querySelector(`[data-node="${item.id}"]`); if (!element) return;
  const holder = document.createElement('div'); holder.innerHTML = nodeHTML(item); const next = holder.firstElementChild; element.replaceWith(next);
  watchMedia(next, item); drawNodeBar();
}

// ---- 分组和多选框 ----
function boundsOf(ids) {
  const items = ids.map(node).filter(Boolean); if (!items.length) return null;
  return { l: Math.min(...items.map(item => item.x)), t: Math.min(...items.map(item => item.y)), r: Math.max(...items.map(item => item.x + item.w)), b: Math.max(...items.map(item => item.y + LABEL + height(item))) };
}
const groupOfSelection = () => cv.groups.find(group => group.nodes.length === sel.size && group.nodes.every(id => sel.has(id)));
function drawGroups() {
  $('.cv-groups').innerHTML = cv.groups.map(group => { const box = boundsOf(group.nodes); return box ? `<div class="cv-group" data-group="${group.id}" style="left:${box.l - 30}px;top:${box.t - 44}px;width:${box.r - box.l + 60}px;height:${box.b - box.t + 74}px"><span class="cv-group-label" title="双击改名">${ctx.escape(group.label)}</span></div>` : ''; }).join('');
}
// 单选一个有成品的节点时，上方的一排按钮：预览、下载，视频多一个分离音视频，音频多一个截取。
function drawNodeBar() {
  const bar = $('.cv-nodebar'); if (!bar) return;
  const item = sel.size === 1 ? node([...sel][0]) : null, url = item && mediaUrl(item);
  if (!item || !url || drag?.moved) { bar.hidden = true; bar.dataset.for = ''; return; }
  const { icon } = ctx, key = `${item.id}|${url}|${trim?.id === item.id}`;
  bar.style.cssText = `left:${item.x}px;top:${item.y - 8}px`; bar.firstElementChild && (bar.firstElementChild.style.transform = `scale(${1 / cv.view.k})`);
  if (bar.dataset.for === key && !bar.hidden) return;
  const button = (action, name, text, title = text) => `<button data-action="${action}" title="${title}">${icon(name, 14)}<span>${text}</span></button>`;
  const tools = item.type === 'audio' ? [button('canvas-trim', 'scissors', '截取', '截取其中一段，生成新的音频节点'), button('canvas-download', 'download', '下载')]
    : item.type === 'video' ? [button('canvas-split', 'split', '分离音视频', '拆成一个无声视频和一段音轨'), button('canvas-preview', 'expand', '预览'), button('canvas-download', 'download', '下载')]
    : [button('canvas-preview', 'expand', '预览'), button('canvas-download', 'download', '下载')];
  bar.innerHTML = `<div class="cv-nodebar-in" style="transform:scale(${1 / cv.view.k})">${tools.join('')}</div>`; bar.dataset.for = key;
  if (bar.hidden) { bar.hidden = false; if (!calm()) bar.firstElementChild.animate([{ opacity: 0, translate: '0 4px' }, { opacity: 1, translate: '0 0' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' }); }
}
function download(item) {
  const url = mediaUrl(item); if (!url) return;
  const link = document.createElement('a'); link.href = url; link.download = `${(item.label || '素材').replace(/[\\/:*?"<>|]/g, '_')}.${url.split('.').pop()}`; document.body.append(link); link.click(); link.remove();
}
// 视频放大预览：盖住画布的一层，点空白处或按 Esc 关掉。
function preview(item) {
  const url = mediaUrl(item); if (!url) return;
  if (item.type === 'image') { const image = root.querySelector(`[data-node="${item.id}"] .cv-node-body img`); if (image) ctx.openImage(image); return; }
  closeViewer(true);
  const viewer = document.createElement('div'); viewer.className = 'cv-viewer'; viewer.innerHTML = `<video src="${ctx.escape(url)}" controls autoplay playsinline></video><button class="cv-viewer-close" aria-label="关闭">${ctx.icon('close', 18)}</button>`;
  viewer.addEventListener('click', event => { if (event.target.tagName !== 'VIDEO') closeViewer(); });
  for (const media of root.querySelectorAll('.cv-node video,.cv-node audio')) media.pause();
  root.append(viewer); if (!calm()) { viewer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 }); viewer.firstElementChild.animate([{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' }); }
}
function closeViewer(now = false) {
  const viewer = $('.cv-viewer'); if (!viewer) return false;
  viewer.querySelector('video')?.pause();
  if (now || calm()) viewer.remove(); else viewer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160 }).finished.then(() => viewer.remove(), () => viewer.remove());
  return true;
}
// 从一个节点派生出新节点（分离、截取、上传）：放在右边，连上线。
function derive(from, input, offsetY = 0) {
  const created = addNode({ source: 'upload', x: from.x + from.w + 150, y: from.y + offsetY, ...input });
  if (from) cv.edges.push({ from: from.id, to: created.id });
  return created;
}
const clipNode = (clip, extra = {}) => ({ type: clip.kind, source: 'upload', url: clip.url, label: (clip.name || (clip.kind === 'audio' ? '音频' : '视频')).slice(0, 40), duration: clip.duration || 0,
  ratio: clip.kind === 'audio' ? AUDIO : clip.width && clip.height ? clip.width / clip.height : 16 / 9, w: clip.kind === 'video' && clip.height > clip.width ? 260 : 320, ...extra });
async function uploadClip(file) {
  const response = await fetch('/api/studio/clips', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Workflow-Token': ctx.state.token, 'X-File-Name': encodeURIComponent(file.name) }, body: file });
  const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.error || '上传失败'); return result;
}

function drawSelBox() {
  const box = $('.cv-selbox'), area = sel.size > 1 ? boundsOf([...sel]) : null;
  if (!area) { box.hidden = true; return; }
  const { icon } = ctx, images = [...sel].some(id => linkable(node(id))), grouped = groupOfSelection(), inverse = 1 / cv.view.k;
  box.hidden = false; box.style.cssText = `left:${area.l - 18}px;top:${area.t - 14}px;width:${area.r - area.l + 36}px;height:${area.b - area.t + 32}px`;
  box.innerHTML = `<div class="cv-seltools" style="transform:scale(${inverse})"><span>已选 ${sel.size} 个</span><button data-action="${grouped ? 'canvas-ungroup' : 'canvas-group'}">${icon('copy', 13)}${grouped ? '解组' : '打组'}</button><button data-action="canvas-delete-selected">${icon('trash', 13)}删除</button></div>${images ? `<button class="cv-handle multi" data-handle-multi style="transform:scale(${inverse})" title="把选中的图片一起连出去" aria-label="一起拉出连线"><i>${icon('plus', 13)}</i></button>` : ''}`;
}
function paintSelection() {
  for (const element of root.querySelectorAll('.cv-node')) element.classList.toggle('selected', sel.has(element.dataset.node));
  if (trim && !sel.has(trim.id)) endTrim();
  drawEdges(); drawSelBox(); drawNodeBar(); bind();
}
// 生成进度、成片回来时只更新变了的节点。
function updateNodes() {
  if (!cv || !root) return; let changed = false;
  for (const item of cv.nodes) {
    if (item.source !== 'gen') continue;
    const job = itemOf(item), body = root.querySelector(`[data-node="${item.id}"] .cv-node-body`); if (!body) continue;
    if (job?.kind === 'image' && job.result && item.url !== job.result.url) { item.url = job.result.url; item.refId = ''; changed = true; }
    const key = bodyKey(item);
    if (body.dataset.key !== key) { body.dataset.key = key; body.innerHTML = bodyHTML(item); watchMedia(body, item); if (!calm()) body.firstElementChild?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320 }); }
    else if (job && !job.result && activeJob(job.job)) {
      const label = body.querySelector('strong'), bar = body.querySelector('.studio-progress b');
      if (label) label.textContent = job.job.message || '生成中'; if (bar) bar.style.width = `${Math.max(6, Number(job.job.progress) || 0)}%`;
    }
  }
  drawEdges(); drawNodeBar(); if (changed) save();
}
// 图片、视频加载出来后按真实比例调整节点高度。
function watchMedia(scope, item) {
  if (item.type === 'audio') return watchAudio(scope, item);
  const media = scope.querySelector('img,video'); if (!media) return;
  const adopt = () => { const w = media.naturalWidth || media.videoWidth, h = media.naturalHeight || media.videoHeight; if (!w || !h) return; const ratio = w / h; if (Math.abs(ratio - item.ratio) < .01) return; item.ratio = ratio; const body = root?.querySelector(`[data-node="${item.id}"] .cv-node-body`); if (body) body.style.aspectRatio = ratio; drawEdges(); drawGroups(); drawSelBox(); placePanel(); save(); };
  if (media.complete || media.readyState >= 1) adopt(); media.addEventListener(media.tagName === 'IMG' ? 'load' : 'loadedmetadata', adopt, { once: true });
}

// ---- 选中的生成节点：下方的输入框 ----
function bind() {
  const only = sel.size === 1 ? node([...sel][0]) : null, target = only?.source === 'gen' ? only : null, panel = $('.cv-panel');
  if (!target) { bound = null; panel.hidden = true; panel.innerHTML = ''; return; }
  const same = bound === target; bound = target;
  Object.assign(draft, { kind: target.type, prompt: target.prompt, refs: imageSources(target).map(item => ({ id: item.refId, url: item.url || BLANK, nodeId: item.id })), audios: audioSources(target).map(item => ({ url: item.url, name: item.label, nodeId: item.id })), ...target.settings });
  settle();
  panel.innerHTML = composerBox(); panel.hidden = false; placePanel();
  if (!same && !calm()) panel.firstElementChild?.animate([{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
function placePanel(animate = false) {
  const panel = $('.cv-panel'); if (!bound || panel.hidden) return;
  const { x, y, k } = cv.view, width = panel.offsetWidth;
  panel.style.transition = animate && !calm() ? 'transform .32s cubic-bezier(.2,.8,.2,1)' : 'none';
  panel.style.transform = `translate(${Math.round(x + (bound.x + bound.w / 2) * k - width / 2)}px,${Math.round(y + (bound.y + LABEL + height(bound)) * k + 14)}px)`;
}
const host = {
  change() {
    if (!bound) return;
    bound.prompt = draft.prompt; bound.settings = { channel: draft.channel, duration: draft.duration, resolution: draft.resolution, aspectRatio: draft.aspectRatio };
    if (!itemOf(bound) && !bound.url) { const ratio = ratioOf(draft.aspectRatio); if (ratio !== bound.ratio) { bound.ratio = ratio; const body = root.querySelector(`[data-node="${bound.id}"] .cv-node-body`); if (body) body.style.aspectRatio = ratio; drawEdges(); placePanel(true); } }
    save();
  },
  removeRef(index) {
    const source = imageSources(bound)[index]; if (!source) return;
    cv.edges = cv.edges.filter(edge => !(edge.from === source.id && edge.to === bound.id));
    dropRef(index); bound.prompt = draft.prompt; paint({ editor: true }); drawEdges(); save();
  },
  removeAudio(index) {
    const source = audioSources(bound)[index]; if (!source) return;
    cv.edges = cv.edges.filter(edge => !(edge.from === source.id && edge.to === bound.id));
    dropAudio(index); bound.prompt = draft.prompt; paint({ editor: true }); drawEdges(); save();
  },
  async addFiles(files) {
    const target = bound, start = target ? { x: target.x - 380, y: target.y } : toWorld(last.x || innerWidth / 2, last.y || innerHeight / 2);
    let offset = 0;
    for (const [index, file] of files.entries()) {
      if (/^(audio|video)\//.test(file.type)) {
        if (file.size > 500 * 1024 * 1024) { ctx.notify('请使用 500MB 以内的音视频文件', true); continue; }
        try {
          ctx.notify(`正在处理 ${file.name}…`);
          const clip = await uploadClip(file), created = addNode(clipNode(clip, { x: start.x, y: start.y + offset }));
          offset += LABEL + height(created) + 60; if (!target) { sel.clear(); sel.add(created.id); paintSelection(); }
        } catch (error) { ctx.notify(error.message, true); }
        continue;
      }
      if (file.size > 15 * 1024 * 1024) { ctx.notify('请使用 15MB 以内的图片', true); continue; }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        const reference = await ctx.api('/api/studio/references', { method: 'POST', body: { base64: btoa(binary), name: file.name } });
        const created = addNode({ type: 'image', source: 'upload', refId: reference.id, url: reference.url, x: start.x, y: start.y + offset + (target ? sources(target).length * 250 : 0), ratio: 16 / 9 }); offset += 250; void index;
        if (target) cv.edges.push({ from: created.id, to: target.id });
      } catch (error) { ctx.notify(error.message, true); }
    }
    drawEdges(); if (target && bound === target) bind(); save();
  },
  // 输入框放大、收起后，挪一下画面让它完整露出来。
  resize() {
    placePanel(true);
    // 直接算出输入框长高后的高度（和样式表里放大后的数值一致），画面和动画同时挪，不等动画走完。
    const panel = $('.cv-panel'), editor = panel?.querySelector('#studio-prompt'); if (!panel || panel.hidden || !editor) return;
    const open = panel.querySelector('.studio-box.expanded'), least = open ? Math.min(innerHeight * .4, 400) : 64, most = open ? innerHeight * .52 : 200;
    const finalHeight = panel.offsetHeight - editor.offsetHeight + Math.min(most, Math.max(least, editor.scrollHeight));
    const top = panel.getBoundingClientRect().top, over = top + finalHeight - (innerHeight - 76);
    if (over > 0) { cv.view.y -= Math.min(over, top - 70); applyView(true); save(); }
  },
  async generate() {
    const target = bound; if (!target) throw new Error('请先选中一个生成节点');
    if (activeJob(itemOf(target)?.job)) throw new Error('这个节点还在生成，等它完成再重新生成');
    const refIds = [];
    for (const [index, source] of imageSources(target).entries()) {
      if (!source.refId) {
        const job = itemOf(source);
        if (!(source.source === 'gen' && job?.kind === 'image' && job.result)) throw new Error(`图${index + 1} 还没有生成好，先等它完成或换一张图`);
        const reference = await ctx.api(`/api/studio/items/${job.id}/reference`, { method: 'POST' }); source.refId = reference.id;
      }
      refIds.push(source.refId);
    }
    const view = await ctx.api('/api/studio/items', { method: 'POST', body: { kind: target.type, prompt: target.prompt, refIds, audioFiles: audioSources(target).map(item => item.url), channel: draft.channel, duration: draft.duration, resolution: draft.resolution, aspectRatio: draft.aspectRatio } });
    target.itemId = view.items[0].id; if (target.type === 'image') { target.url = ''; target.refId = ''; }
    save(); ctx.notify(target.type === 'video' ? '已提交，视频生成需要几分钟' : '已提交，图片马上就好');
    return view;
  },
};

// 新节点和它下面的输入框如果有一部分在屏幕外，把画面平滑挪过去。
function reveal(item) {
  const { x, y, k } = cv.view, panel = 640, left = x + (item.x + item.w / 2) * k - panel / 2, right = left + panel, top = y + item.y * k, bottom = y + (item.y + LABEL + height(item)) * k + 230;
  const dx = left < 20 ? 20 - left : right > innerWidth - 20 ? innerWidth - 20 - right : 0, dy = top < 70 ? 70 - top : bottom > innerHeight - 70 ? innerHeight - 70 - bottom : 0;
  if (dx || dy) { cv.view.x += dx; cv.view.y += dy; applyView(true); save(); }
}

// ---- 节点增删 ----
function addNode(input) {
  const count = cv.nodes.filter(item => item.type === input.type).length + 1;
  const item = { id: uid(), w: 320, ratio: 16 / 9, source: 'gen', refId: '', url: '', itemId: '', prompt: '', label: `${input.type === 'video' ? '视频' : '图片'} ${count}`, settings: { channel: draft.channel, duration: draft.duration, resolution: draft.resolution, aspectRatio: '16:9' }, ...input };
  cv.nodes.push(item);
  const holder = document.createElement('div'); holder.innerHTML = nodeHTML(item, true); const element = holder.firstElementChild;
  $('.cv-nodes').append(element); watchMedia(element, item); toggleEmpty();
  return item;
}
function removeSelected() {
  if (!sel.size) return;
  const busy = [...sel].map(node).filter(item => activeJob(itemOf(item)?.job));
  if (busy.length && !confirm('有节点还在生成。删掉节点不会取消任务，成片仍会出现在“创作”的作品里。继续删除？')) return;
  cv.nodes = cv.nodes.filter(item => !sel.has(item.id)); cv.edges = cv.edges.filter(edge => !sel.has(edge.from) && !sel.has(edge.to));
  if (trim && sel.has(trim.id)) trim = null;
  for (const id of sel) root.querySelector(`[data-node="${id}"]`)?.remove();
  cv.groups = cv.groups.map(group => ({ ...group, nodes: group.nodes.filter(id => !sel.has(id)) })).filter(group => group.nodes.length);
  sel.clear(); drawGroups(); paintSelection(); toggleEmpty(); save();
}
function createFromMenu(kind) {
  const state = menuState; closeMenu(); menuState = null; if (!state) return;
  const point = toWorld(state.clientX, state.clientY), ratio = 16 / 9, w = 320;
  const created = addNode({ type: kind, x: point.x, y: point.y - LABEL - w / ratio / 2 });
  for (const id of state.from || []) if (fits(node(id), created) && !(node(id).type === 'audio' && audioSources(created).length >= 3)) cv.edges.push({ from: id, to: created.id });
  sel.clear(); sel.add(created.id); paintSelection(); reveal(created); save();
  requestAnimationFrame(() => document.querySelector('#studio-prompt')?.focus({ preventScroll: true }));
}
const filePicker = document.createElement('input'); filePicker.type = 'file'; filePicker.accept = 'image/png,image/jpeg,image/webp,audio/*,video/*'; filePicker.multiple = true; filePicker.hidden = true; document.body.append(filePicker);
filePicker.addEventListener('change', () => { const files = [...filePicker.files]; filePicker.value = ''; if (cv && files.length) host.addFiles(files); });
const picker = () => filePicker.click();
function openMenu(clientX, clientY, from = null) {
  const { icon } = ctx, menu = $('.cv-menu'); menuState = { clientX, clientY, from, world: toWorld(clientX, clientY) };
  const onlyAudio = from?.length && from.every(id => node(id)?.type === 'audio');
  menu.innerHTML = `<small>${from ? '用它生成' : '添加节点'}</small>${onlyAudio ? '' : `<button data-action="canvas-add" data-kind="image">${icon('image', 15)}图片</button>`}<button data-action="canvas-add" data-kind="video">${icon('play', 15)}视频</button>${from ? '' : `<button data-action="canvas-add" data-kind="upload">${icon('upload', 15)}上传素材</button>`}`;
  menu.hidden = false; menu.style.left = `${Math.min(clientX, innerWidth - 190)}px`; menu.style.top = `${Math.min(clientY - 16, innerHeight - 170)}px`;
  if (!calm()) menu.animate([{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
function closeMenu() { const menu = $('.cv-menu'); if (menu && !menu.hidden) { menu.hidden = true; menuState = null; drawEdges(); } }

// ---- 鼠标：拖动画面、框选、移动节点、拉线 ----
function onDown(event) {
  last.x = event.clientX; last.y = event.clientY;
  if (event.target.closest('.cv-panel,.cv-top,.cv-zoom,.cv-dock,.cv-menu,.cv-empty button,.cv-seltools,.cv-nodebar,.cv-trimbar,.cv-viewer')) return;
  closeMenu();
  const play = event.target.closest('[data-play]');
  if (play && event.button === 0 && !space) { event.preventDefault(); return togglePlay(play.closest('.cv-node')); }
  const grip = event.target.closest('[data-trim]');
  if (grip && trim && event.button === 0 && !space) { event.preventDefault(); drag = { kind: 'trim', part: grip.dataset.trim, x: event.clientX, y: event.clientY, start: trim.start, end: trim.end, width: grip.closest('.cv-wave').getBoundingClientRect().width * (1 - 16 / grip.closest('.cv-wave').offsetWidth), moved: false, pan: { x: 0, y: 0 } }; try { root.setPointerCapture(event.pointerId); } catch {} return; }
  const wave = !grip && event.target.closest('.cv-wave'), owner = wave && event.target.closest('.cv-node');
  if (owner && event.button === 0 && !space && (event.target.closest('[data-seek]') || (sel.size === 1 && sel.has(owner.dataset.node)))) {
    event.preventDefault(); if (!sel.has(owner.dataset.node) || sel.size > 1) { sel.clear(); sel.add(owner.dataset.node); paintSelection(); }
    drag = { kind: 'seek', element: owner, x: event.clientX, y: event.clientY, moved: false, pan: { x: 0, y: 0 } }; try { root.setPointerCapture(event.pointerId); } catch {}
    return seekTo(owner, event.clientX);
  }
  const groupElement = event.target.closest('.cv-group'), group = groupElement && cv.groups.find(entry => entry.id === groupElement.dataset.group);
  if (group && event.button === 0 && !space) { if (!event.shiftKey) sel.clear(); for (const member of group.nodes) sel.add(member); paintSelection(); }
  const element = event.target.closest('.cv-node') || (group && root.querySelector(`[data-node="${group.nodes[0]}"]`)), id = element?.dataset.node;
  if (event.button === 1 || (event.button === 0 && space)) { event.preventDefault(); drag = { kind: 'pan', x: event.clientX, y: event.clientY, vx: cv.view.x, vy: cv.view.y }; root.classList.add('grabbing'); }
  else if (event.button !== 0) return;
  else if (event.target.closest('[data-handle-multi]')) { drag = { kind: 'link', multi: true, from: [...sel].filter(other => linkable(node(other))), x: event.clientX, y: event.clientY, moved: false }; root.classList.add('linking'); }
  else if (event.target.closest('[data-handle]')) { const from = sel.has(id) ? [...sel].filter(other => linkable(node(other))) : [id]; drag = { kind: 'link', from, x: event.clientX, y: event.clientY, moved: false }; root.classList.add('linking'); }
  else if (element) {
    // 视频底部那条是播放控件，留给它自己用；画面其它地方按住就能拖。
    const video = event.target.tagName === 'VIDEO' ? event.target : null;
    if (video && event.clientY > video.getBoundingClientRect().bottom - 46 * cv.view.k) { if (!sel.has(id) || sel.size > 1) { sel.clear(); sel.add(id); paintSelection(); } return; }
    const was = sel.has(id) || Boolean(group);
    if (!sel.has(id)) { if (!event.shiftKey) sel.clear(); sel.add(id); paintSelection(); }
    drag = { kind: 'move', id, was, video, group: Boolean(group), shift: event.shiftKey, x: event.clientX, y: event.clientY, moved: false, start: [...sel].map(other => { const item = node(other); return { item, x: item.x, y: item.y, element: root.querySelector(`[data-node="${other}"]`) }; }) };
  } else { drag = { kind: 'marquee', x: event.clientX, y: event.clientY, moved: false, base: event.shiftKey ? new Set(sel) : new Set() }; document.activeElement?.blur?.(); }
  if (drag) { drag.pan = { x: 0, y: 0 }; if (drag.kind === 'marquee') { const origin = toWorld(drag.x, drag.y); drag.wx = origin.x; drag.wy = origin.y; } try { root.setPointerCapture(event.pointerId); } catch {} event.preventDefault(); }
}
// 加号的磁吸：鼠标进到它周围一圈，圆点就朝鼠标靠过来一点。
let pulled = null;
function magnet(event) {
  const handle = drag ? null : event.target.closest?.('.cv-handle');
  if (pulled && pulled !== handle) { pulled.style.removeProperty('--mx'); pulled.style.removeProperty('--my'); pulled = null; }
  if (!handle) return;
  const rect = handle.getBoundingClientRect(), scale = rect.width / handle.offsetWidth || 1, limit = 15;
  const pull = value => `${Math.max(-limit, Math.min(limit, value * .55 / scale))}px`;
  handle.style.setProperty('--mx', pull(event.clientX - rect.left - rect.width / 2)); handle.style.setProperty('--my', pull(event.clientY - rect.top - rect.height / 2)); pulled = handle;
}
function onMove(event) {
  last.x = event.clientX; last.y = event.clientY; magnet(event); if (!drag) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) > 3) { drag.moved = true; drawNodeBar(); }
  if (drag.kind === 'pan') { cv.view.x = drag.vx + dx; cv.view.y = drag.vy + dy; applyView(); return; }
  if (!drag.moved) return;
  follow();
  if (['move', 'marquee', 'link'].includes(drag.kind) && !edgeTimer) edgeTimer = requestAnimationFrame(edgePan);
}
// 拖着节点、连线或框选靠近窗口边缘时，画面自动朝那边移，越靠边越快。
function edgePan() {
  edgeTimer = 0; if (!drag || !drag.moved || !['move', 'marquee', 'link'].includes(drag.kind)) return;
  const zone = 64, push = gap => gap < zone ? Math.pow((zone - Math.max(0, gap)) / zone, 1.6) * 20 : 0;
  const vx = push(last.x) - push(innerWidth - last.x), vy = push(last.y) - push(innerHeight - last.y);
  if (vx || vy) { cv.view.x += vx; cv.view.y += vy; drag.pan.x += vx; drag.pan.y += vy; applyView(); follow(); }
  edgeTimer = requestAnimationFrame(edgePan);
}
function follow() {
  if (drag.kind === 'seek') return seekTo(drag.element, last.x);
  const dx = last.x - drag.x - drag.pan.x, dy = last.y - drag.y - drag.pan.y;
  if (drag.kind === 'trim') {
    const item = node(trim?.id), total = item?.duration || 0; if (!total) return;
    const shift = (last.x - drag.x) / drag.width * total, least = Math.min(.5, total);
    if (drag.part === 'l') trim.start = Math.min(Math.max(0, drag.start + shift), trim.end - least);
    else if (drag.part === 'r') trim.end = Math.max(Math.min(total, drag.end + shift), trim.start + least);
    else { const length = drag.end - drag.start, from = Math.min(Math.max(0, drag.start + shift), total - length); trim.start = from; trim.end = from + length; }
    return paintTrim();
  }
  if (drag.kind === 'move') {
    for (const entry of drag.start) { entry.item.x = entry.x + dx / cv.view.k; entry.item.y = entry.y + dy / cv.view.k; entry.element.style.left = `${entry.item.x}px`; entry.element.style.top = `${entry.item.y}px`; }
    root.classList.add('moving'); drawEdges(); drawGroups(); drawSelBox(); placePanel();
  } else if (drag.kind === 'marquee') {
    const origin = { x: cv.view.x + drag.wx * cv.view.k, y: cv.view.y + drag.wy * cv.view.k };
    const box = $('.cv-marquee'), left = Math.min(origin.x, last.x), top = Math.min(origin.y, last.y), width = Math.abs(last.x - origin.x), tall = Math.abs(last.y - origin.y);
    box.hidden = false; box.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${tall}px`;
    const a = toWorld(left, top), b = toWorld(left + width, top + tall); sel.clear(); for (const id of drag.base) sel.add(id);
    for (const item of cv.nodes) if (item.x < b.x && item.x + item.w > a.x && item.y < b.y && item.y + LABEL + height(item) > a.y) sel.add(item.id);
    for (const element of root.querySelectorAll('.cv-node')) element.classList.toggle('selected', sel.has(element.dataset.node));
    drawSelBox();
  } else if (drag.kind === 'link') {
    const to = toWorld(last.x, last.y), over = document.elementFromPoint(last.x, last.y)?.closest?.('.cv-node');
    for (const element of root.querySelectorAll('.cv-node.target')) element.classList.remove('target');
    const target = over && node(over.dataset.node); if (drag.from.some(id => fits(node(id), target))) over.classList.add('target');
    drag.to = to; drawEdges();
  }
}
function onUp(event) {
  const current = drag; drag = null; if (!current) return;
  cancelAnimationFrame(edgeTimer); edgeTimer = 0;
  root.classList.remove('grabbing', 'moving', 'linking');
  if (current.kind === 'trim' || current.kind === 'seek') return;
  if (current.pan.x || current.pan.y) save();
  drawNodeBar();
  if (current.kind === 'pan') return save();
  if (current.kind === 'move') {
    if (current.moved) return save();
    // 已选中的视频，点一下画面（没拖动）就播放或暂停。
    if (current.video && current.was && !current.shift && sel.size === 1) { if (current.video.paused) current.video.play().catch(() => {}); else current.video.pause(); }
    if (current.group) return paintSelection();
    if (current.shift && current.was) sel.delete(current.id); else if (!current.shift && sel.size > 1) { sel.clear(); sel.add(current.id); }
    return paintSelection();
  }
  if (current.kind === 'marquee') { $('.cv-marquee').hidden = true; if (!current.moved) { sel.clear(); for (const id of current.base) sel.add(id); } return paintSelection(); }
  if (current.kind === 'link') {
    for (const element of root.querySelectorAll('.cv-node.target')) element.classList.remove('target');
    const over = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.cv-node'), target = over && node(over.dataset.node);
    if (target?.source === 'gen' && !current.from.includes(target.id)) {
      const usable = current.from.filter(id => fits(node(id), target));
      if (!usable.length) { ctx.notify('音频只能连到视频生成节点，当参考音频用', true); return drawEdges(); }
      if (usable.length < current.from.length) ctx.notify('音频只能连到视频生成节点，已跳过音频', true);
      for (const id of usable) {
        if (cv.edges.some(edge => edge.from === id && edge.to === target.id)) continue;
        if (node(id).type === 'audio' && audioSources(target).length >= 3) { ctx.notify('一个视频最多连 3 段参考音频', true); continue; }
        cv.edges.push({ from: id, to: target.id });
      }
      sel.clear(); sel.add(target.id); paintSelection(); return save();
    }
    if (over && current.moved) return drawEdges();
    // 松手在空白处：线先留着，弹出菜单选要生成什么。
    const point = current.moved ? { x: event.clientX, y: event.clientY } : (() => { const area = current.multi && boundsOf(current.from), out = area ? { x: area.r + 18, y: (area.t + area.b) / 2 } : anchorOut(node(current.from[0])); return { x: cv.view.x + (out.x + 150) * cv.view.k, y: cv.view.y + out.y * cv.view.k }; })();
    openMenu(point.x, point.y, current.from);
    drawEdges();
  }
}
function onWheel(event) {
  if (event.target.closest('.cv-panel,.cv-menu,.cv-viewer')) return;
  event.preventDefault();
  const mouse = event.deltaMode !== 0 || (event.deltaX === 0 && Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= 50);
  if (event.ctrlKey || event.metaKey || mouse) zoomAt(cv.view.k * Math.exp(-event.deltaY * (event.ctrlKey && !mouse ? .01 : .0015) * (event.deltaMode === 1 ? 16 : 1)), event.clientX, event.clientY);
  else { cv.view.x -= event.deltaX; cv.view.y -= event.deltaY; applyView(); save(); }
}
const typing = target => target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '');
document.addEventListener('keydown', event => {
  if (!cv || ctx.state.modal || document.querySelector('.image-lightbox')) return;
  if (event.key === 'Escape' && !typing(event.target)) { if (closeViewer()) return; if (menuState) return closeMenu(); if (trim) return endTrim(); sel.clear(); return paintSelection(); }
  if (typing(event.target)) return;
  if ($('.cv-viewer')) return;
  if (event.code === 'Space') { event.preventDefault(); if (!space) { space = true; root.classList.add('grab'); } return; }
  if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); return removeSelected(); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); for (const item of cv.nodes) sel.add(item.id); return paintSelection(); }
  if ((event.metaKey || event.ctrlKey) && event.key === '0') { event.preventDefault(); zoomAt(1, innerWidth / 2, innerHeight / 2, true); }
});
const release = () => { space = false; root?.classList.remove('grab'); };
document.addEventListener('keyup', event => { if (event.code === 'Space') release(); });
addEventListener('blur', release);
document.addEventListener('dragover', event => { if (cv) { last.x = event.clientX; last.y = event.clientY; } });
addEventListener('resize', () => { if (cv) placePanel(); });

// ---- 打开、关闭 ----
function open(canvas) {
  cv = canvas; cv.groups ||= []; sel.clear(); bound = null;
  if (!cv.nodes.length && !cv.view.x && !cv.view.y) cv.view = { x: innerWidth / 2 - 160, y: innerHeight / 2 - 160, k: 1 };
  const { escape, icon } = ctx;
  root = document.createElement('div'); root.className = 'cv'; root.tabIndex = -1;
  root.innerHTML = `<div class="cv-world"><div class="cv-groups"></div><svg class="cv-edges" aria-hidden="true"></svg><div class="cv-nodes"></div><div class="cv-selbox" hidden></div><div class="cv-nodebar" hidden></div></div><div class="cv-marquee" hidden></div>
<div class="cv-top"><button class="cv-back" data-action="canvas-close" title="返回">${icon('arrow', 15)}</button><input class="cv-title" value="${escape(cv.title)}" maxlength="60" aria-label="画布名称" spellcheck="false"></div>
<div class="cv-empty"><p>双击画布添加节点</p><div><button data-action="canvas-add" data-kind="image">${icon('image', 15)}图片生成</button><button data-action="canvas-add" data-kind="video">${icon('play', 15)}视频生成</button><button data-action="canvas-add" data-kind="upload">${icon('upload', 15)}上传素材</button></div></div>
<div class="cv-panel studio-composer" hidden></div><div class="cv-menu" hidden></div>
<div class="cv-zoom"><button data-action="canvas-zoom" data-dir="out" aria-label="缩小">−</button><output>100%</output><button data-action="canvas-zoom" data-dir="in" aria-label="放大">＋</button><button data-action="canvas-zoom" data-dir="fit" title="看全部节点">适应</button></div>
<div class="cv-dock"><button data-action="canvas-add" data-kind="image" title="添加图片生成节点">${icon('image', 16)}</button><button data-action="canvas-add" data-kind="video" title="添加视频生成节点">${icon('play', 16)}</button><button data-action="canvas-add" data-kind="upload" title="上传图片、音频或视频">${icon('upload', 16)}</button><i></i><span>空格 拖动画面 · 滚轮 缩放 · 拖动 框选 · Delete 删除</span></div>`;
  document.body.append(root); document.documentElement.classList.add('cv-open');
  root.addEventListener('pointerdown', onDown); root.addEventListener('pointermove', onMove); root.addEventListener('pointerup', onUp); root.addEventListener('pointercancel', onUp);
  root.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('dblclick', event => {
    const under = document.elementFromPoint(event.clientX, event.clientY), element = under?.closest('.cv-node');
    if (under?.closest('.cv-panel,.cv-top,.cv-zoom,.cv-dock,.cv-menu,.cv-empty button,.cv-seltools,.cv-nodebar,.cv-trimbar,.cv-viewer,.cv-audio')) return;
    const label = under?.closest('.cv-group-label'), named = label && cv.groups.find(entry => entry.id === label.parentElement.dataset.group);
    if (named) { const next = prompt('分组名称', named.label); if (next !== null) { named.label = next.trim().slice(0, 40) || named.label; drawGroups(); save(); } return; }
    if (under?.closest('.cv-group') && !under.closest('.cv-node')) return;
    if (element) { const item = node(element.dataset.node); if (item && mediaUrl(item) && item.type !== 'audio') preview(item); return; }
    openMenu(event.clientX, event.clientY);
  });
  root.querySelector('.cv-title').addEventListener('input', event => { cv.title = event.target.value; save(); });
  setHost(host); drawNodes(); for (const item of cv.nodes) watchMedia(root.querySelector(`[data-node="${item.id}"]`), item); applyView();
  if (!calm()) root.animate([{ opacity: 0, transform: 'scale(1.015)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
async function close() {
  if (!cv) return; const leaving = root; await save(false);
  for (const media of leaving.querySelectorAll('audio,video')) media.pause();
  cv = null; root = null; bound = null; trim = null; sel.clear(); release(); setHost(null); document.documentElement.classList.remove('cv-open');
  if (calm()) leaving.remove(); else leaving.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180 }).finished.then(() => leaving.remove(), () => leaving.remove());
  await refreshList();
}

export async function canvasAction(action, button) {
  const { api } = ctx;
  if (action === 'canvas-new') { await loadData(); return open(await api('/api/studio/canvases', { method: 'POST', body: { title: `画布 ${list.length + 1}` } })); }
  if (action === 'canvas-open') { await loadData(); return open(await api(`/api/studio/canvases/${encodeURIComponent(button.dataset.id)}`)); }
  if (action === 'canvas-delete') { if (!confirm('删除这张画布？已生成的图片和视频仍保留在“创作”的作品里。')) return; await api(`/api/studio/canvases/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' }); return refreshList(); }
  if (!cv) return;
  if (action === 'canvas-close') return close();
  if (action === 'canvas-group') {
    if (sel.size < 2) return;
    // 一个节点只属于一个组：先从原来的组里拿出来。
    cv.groups = cv.groups.map(group => ({ ...group, nodes: group.nodes.filter(id => !sel.has(id)) })).filter(group => group.nodes.length);
    cv.groups.push({ id: uid(), label: `分组 ${cv.groups.length + 1}`, nodes: [...sel] }); drawGroups(); drawSelBox(); return save();
  }
  if (action === 'canvas-ungroup') { const group = groupOfSelection(); if (group) { cv.groups = cv.groups.filter(entry => entry !== group); drawGroups(); drawSelBox(); save(); } return; }
  if (action === 'canvas-delete-selected') return removeSelected();
  const picked = sel.size === 1 ? node([...sel][0]) : null;
  if (action === 'canvas-download') return picked && download(picked);
  if (action === 'canvas-preview') return picked && preview(picked);
  if (action === 'canvas-trim') return picked?.type === 'audio' && (trim?.id === picked.id ? endTrim() : startTrim(picked));
  if (action === 'canvas-trim-cancel') return endTrim();
  if (action === 'canvas-trim-run') {
    const item = trim && node(trim.id); if (!item || trim.busy) return;
    trim.busy = true; button.disabled = true; button.textContent = '生成中…';
    try {
      const clip = await api('/api/studio/trim', { method: 'POST', body: { file: item.url, start: trim.start, end: trim.end, name: item.label } });
      endTrim(); const created = derive(item, clipNode(clip)); sel.clear(); sel.add(created.id); paintSelection(); reveal(created); save();
    } catch (error) { if (trim) trim.busy = false; button.disabled = false; button.textContent = '生成'; throw error; }
    return;
  }
  if (action === 'canvas-split') {
    if (picked?.type !== 'video' || button.disabled) return;
    const url = mediaUrl(picked); button.disabled = true; button.querySelector('span').textContent = '分离中…';
    try {
      const { video, audio } = await api('/api/studio/split', { method: 'POST', body: { file: url, name: picked.label } });
      const sound = derive(picked, clipNode(audio), -40), silent = derive(picked, clipNode(video), -40 + LABEL + height(sound) + 70);
      drawEdges(); save(); reveal(silent); ctx.notify('已分离成无声视频和音轨');
    } finally { button.disabled = false; const label = button.querySelector('span'); if (label) label.textContent = '分离音视频'; }
    return;
  }
  if (action === 'canvas-zoom') { const dir = button.dataset.dir; return dir === 'fit' ? fit() : zoomAt(cv.view.k * (dir === 'in' ? 1.25 : .8), innerWidth / 2, innerHeight / 2, true); }
  if (action === 'canvas-add') {
    if (!menuState) { const rect = button.closest('.cv-dock,.cv-empty') ? { x: innerWidth / 2 + (cv.nodes.length % 6) * 26 - 160, y: innerHeight / 2 + (cv.nodes.length % 6) * 26 - 60 } : { x: last.x, y: last.y }; menuState = { clientX: rect.x, clientY: rect.y, from: null }; }
    if (button.dataset.kind === 'upload') { const state = menuState; closeMenu(); menuState = null; last.x = state.clientX; last.y = state.clientY; sel.clear(); paintSelection(); return picker(); }
    return createFromMenu(button.dataset.kind);
  }
}
