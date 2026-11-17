// 自由创作：不拆剧本和分镜，一段提示词加参考图直接生成视频或图片。
// 输入区的内容记在 draft 里（提示词是带 @图N 的纯文字），整页重画后原样还原；
// 页面内的切换只改动必要的一小块，不整页重画，这样输入不会被打断，过渡也连贯。
let ctx = null, data = null, timer = null, uploading = 0, lastJSON = '', mode = 'create';
// 画布打开时由它接管输入框：draft 指向选中节点的内容，增删参考图和生成都交给画布处理。
let host = null, expanded = false;
// 画布里除了图片，还能放音频和视频素材。
const isMedia = file => /^(audio|video)\//.test(file.type);
export function setHost(next) { host = next; if (!next) draft.audios = []; closePop(); hideMenu(); hidePeek(); }
export const draft = { kind: 'video', prompt: '', refs: [], audios: [], channel: '', duration: 0, resolution: '', aspectRatio: '16:9' };
try { Object.assign(draft, JSON.parse(localStorage.getItem('drama-studio') || '{}')); } catch {}
draft.prompt = ''; draft.refs = [];
const remember = () => { if (host) return host.change?.(); try { localStorage.setItem('drama-studio', JSON.stringify({ kind: draft.kind, channel: draft.channel, duration: draft.duration, resolution: draft.resolution, aspectRatio: draft.aspectRatio })); } catch {} };
export const activeJob = job => ['pending', 'submitting', 'queued', 'running', 'downloading'].includes(job?.state);
export const stateLabel = { pending: '等待开始', submitting: '正在提交', queued: '排队中', running: '生成中', downloading: '下载中', completed: '已完成', failed: '生成失败', unknown: '待核对' };
const visible = () => ctx?.state.screen === 'studio';
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = selector => document.querySelector(selector);
const ZW = '​';
const glyphs = {
  up: 'M12 19V5m-6 6 6-6 6 6', down: 'm6 9 6 6 6-6', check: 'm5 12 4 4L19 6',
  at: 'M16 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0zm0 0v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1',
  cube: 'm12 3 8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12 4 7.5',
  timer: 'M12 8v4.5l2.5 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', canvas: 'M8 3v18M16 3v18M3 8h18M3 16h18',
};
const glyph = (name, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${glyphs[name]}"/></svg>`;
const shape = ratio => { const [w, h] = { '16:9': [22, 13], '9:16': [12, 20], '1:1': [16, 16] }[ratio] || [18, 14]; return `<i class="studio-shape" style="width:${w}px;height:${h}px"></i>`; };
const fade = (node, from = 6) => { if (node && !calm()) node.animate([{ opacity: 0, transform: `translateY(${from}px)` }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' }); };

export function initStudio(context) { ctx = context; }

const listeners = new Set();
export const studioData = () => data;
export function onData(fn) { listeners.add(fn); }
function setData(next) { data = next; for (const fn of listeners) fn(data); }
export async function loadData() { if (!data) { setData(await ctx.api('/api/studio')); settle(); } if (!timer) timer = setInterval(refresh, 2000); return data; }
function channel() { return data?.channels.find(item => item.value === draft.channel) || data?.channels[0] || null; }
function limit() { return draft.kind === 'image' ? data?.image.maxReference ?? 0 : channel()?.maxReference ?? 9; }
function ready() { const current = channel(); return draft.kind === 'video' ? Boolean(current) && !current.unavailable : Boolean(data?.image.configured); }
// 渠道变了以后，把时长和分辨率拉回这个模型支持的范围。
export function settle() {
  const current = channel(); if (!current) return;
  draft.channel = current.value;
  if (!(draft.duration >= current.minDuration && draft.duration <= current.maxDuration)) draft.duration = current.defaultDuration;
  if (!current.resolutions.includes(draft.resolution)) draft.resolution = current.defaultResolution;
  if (!(data.ratios || []).includes(draft.aspectRatio)) draft.aspectRatio = '16:9';
}

export async function openStudio() {
  setData(await ctx.api('/api/studio')); lastJSON = JSON.stringify(data.items); settle();
  clearInterval(timer); timer = setInterval(refresh, 2000);
  if (mode === 'canvas') await ctx.canvas.loadList();
}
async function refresh() {
  if (!visible() && !host) { clearInterval(timer); timer = null; closePop(); hidePeek(); hideMenu(); return; }
  try { setData(await ctx.api('/api/studio')); updateFeed(); } catch {}
}

// ---- 作品列表 ----
const emptyFeed = () => `<div class="studio-empty">还没有作品</div>`;
const mediaKey = item => JSON.stringify([item.result?.url || '', item.job.state, item.job.error]);
const infoKey = item => JSON.stringify([item.prompt, item.refs, item.job.canResume, activeJob(item.job), Boolean(item.result)]);
function richPrompt(item) {
  return item.prompt.split(/(@图\d+ ?)/).map(part => {
    const match = /^@图(\d+)/.exec(part), ref = match && item.refs[Number(match[1]) - 1];
    return ref ? `<span class="studio-at mini" data-peek="${ctx.escape(ref.url)}"><img src="${ctx.escape(ref.url)}" alt="${ctx.escape(ref.name)}" data-zoom-image loading="lazy"><b>${ctx.escape(ref.name)}</b></span>` : ctx.escape(part);
  }).join('');
}
export function mediaHTML(item) {
  const { escape, icon } = ctx, job = item.job, running = activeJob(job), failed = ['failed', 'unknown'].includes(job.state);
  if (item.result) return item.kind === 'video' ? `<video src="${escape(item.result.url)}" controls preload="metadata" playsinline></video>` : `<img src="${escape(item.result.url)}" alt="生成的图片" data-zoom-image tabindex="0">`;
  return `<div class="studio-pending ${failed ? 'failed' : ''}">${failed ? icon('alert', 20) : ''}<strong>${escape(running && job.message ? job.message : stateLabel[job.state] || '')}</strong>${running ? `<i class="studio-progress"><b style="width:${Math.max(6, Number(job.progress) || 0)}%"></b></i>` : ''}${failed ? `<p>${escape(job.error || '任务失败')}</p>` : ''}</div>`;
}
function infoHTML(item) {
  const { escape, icon } = ctx, running = activeJob(item.job);
  const meta = [item.model, item.kind === 'video' ? `${Number(item.duration)} 秒` : '', item.kind === 'video' ? item.resolution : '', item.aspectRatio, new Date(item.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })].filter(Boolean);
  return `<p class="studio-prompt-text">${richPrompt(item)}</p><div class="studio-meta">${meta.map(text => `<span>${escape(text)}</span>`).join('')}</div><div class="studio-actions"><button class="small ghost" data-action="studio-reuse" data-id="${escape(item.id)}" title="把提示词、参考图和参数放回输入框">${icon('edit', 13)}再次编辑</button>${item.result ? `<a class="button-link small" href="${escape(item.result.url)}" download="${escape(item.result.file)}">${icon('download', 13)}下载</a>` : ''}${item.job.canResume ? `<button class="small ghost" data-action="studio-resume" data-id="${escape(item.id)}" title="接着查询原来的任务，不会重新提交和扣费">${icon('clock', 13)}继续查询</button>` : ''}<span class="spacer"></span><button class="small ghost icon-button" data-action="studio-delete" data-id="${escape(item.id)}" title="删除这条记录" ${running ? 'disabled' : ''}>${icon('trash', 14)}</button></div>`;
}
const card = (item, fresh = false) => `<article class="studio-card ${fresh ? 'is-new' : ''}" data-studio-item="${ctx.escape(item.id)}"><div class="studio-media ${item.result ? '' : 'waiting'}" data-key="${ctx.escape(mediaKey(item))}">${mediaHTML(item)}</div><div class="studio-info" data-key="${ctx.escape(infoKey(item))}">${infoHTML(item)}</div></article>`;

function updateFeed() {
  const json = JSON.stringify(data.items); if (json === lastJSON) return; lastJSON = json;
  const feed = $('#studio-feed'); if (!feed) return;
  if (!data.items.length) { feed.innerHTML = emptyFeed(); return; }
  feed.querySelector('.studio-empty')?.remove();
  const existing = new Map([...feed.querySelectorAll('[data-studio-item]')].map(node => [node.dataset.studioItem, node]));
  let previous = null;
  for (const item of data.items) {
    let node = existing.get(item.id);
    if (!node) { const holder = document.createElement('div'); holder.innerHTML = card(item, true); node = holder.firstElementChild; }
    else {
      const media = node.querySelector('.studio-media'), info = node.querySelector('.studio-info');
      if (media.dataset.key !== mediaKey(item)) { media.dataset.key = mediaKey(item); media.className = `studio-media ${item.result ? '' : 'waiting'}`; media.innerHTML = mediaHTML(item); fade(media.firstElementChild, 0); }
      else if (!item.result && activeJob(item.job)) {
        // 只是进度变了：改文字和进度条宽度，不重建节点。
        const label = media.querySelector('strong'), bar = media.querySelector('.studio-progress b');
        if (label) label.textContent = item.job.message || stateLabel[item.job.state] || '';
        if (bar) bar.style.width = `${Math.max(6, Number(item.job.progress) || 0)}%`;
      }
      if (info.dataset.key !== infoKey(item)) { info.dataset.key = infoKey(item); info.innerHTML = infoHTML(item); }
    }
    existing.delete(item.id);
    if (previous ? previous.nextElementSibling !== node : feed.firstElementChild !== node) previous ? previous.after(node) : feed.prepend(node);
    previous = node;
  }
  for (const node of existing.values()) node.remove();
}

// ---- 页面 ----
const chipHTML = index => { const ref = draft.refs[index - 1]; return `<span class="studio-at" contenteditable="false" data-index="${index}" data-peek="${ctx.escape(ref.url)}"><img src="${ctx.escape(ref.url)}" alt="图${index}" data-zoom-image draggable="false"><b>图${index}</b></span>${ZW}`; };
// 参考音频的标签：没有缩略图，用一个声波图标。
const audioChipHTML = index => `<span class="studio-at audio" contenteditable="false" data-audio="${index}"><i>${ctx.icon('wave', 13)}</i><b>音频${index}</b></span>${ZW}`;
const editorHTML = () => draft.prompt.split(/(@图\d+ ?|@音频\d+ ?)/).map(part => {
  const picture = /^@图(\d+)/.exec(part); if (picture && draft.refs[Number(picture[1]) - 1]) return chipHTML(Number(picture[1]));
  const sound = /^@音频(\d+)/.exec(part); if (sound && draft.audios[Number(sound[1]) - 1]) return audioChipHTML(Number(sound[1]));
  return ctx.escape(part);
}).join('');
const placeholder = () => limit() > 0 ? '描述你想要的画面，输入 @ 引用参考图' : '描述你想要的画面';
function refsHTML() {
  const { escape, icon } = ctx, max = limit();
  const refs = draft.refs.map((ref, index) => `<div class="studio-ref"><img src="${escape(ref.url)}" alt="图${index + 1}" data-zoom-image data-peek="${escape(ref.url)}" tabindex="0" draggable="false"><span>图${index + 1}</span><button class="studio-ref-remove" data-action="studio-remove-ref" data-index="${index}" aria-label="移除图${index + 1}">${icon('close', 10)}</button></div>`).join('');
  const add = max > 0 ? `<button class="studio-ref-add" data-action="studio-add-ref" title="添加参考图（最多 ${max} 张），也可以直接拖进来或粘贴" ${draft.refs.length >= max ? 'disabled' : ''}>${uploading ? icon('refresh', 16, 'spin') : icon('plus', 17)}</button>` : '';
  const audios = draft.kind === 'video' ? draft.audios.map((audio, index) => `<div class="studio-ref audio" title="${escape(audio.name || '')}"><i>${icon('wave', 18)}</i><span>音频${index + 1}</span><button class="studio-ref-remove" data-action="studio-remove-audio" data-index="${index}" aria-label="移除音频${index + 1}">${icon('close', 10)}</button></div>`).join('') : '';
  return refs + audios + add;
}
function barHTML() {
  const { escape } = ctx, video = draft.kind === 'video', current = channel();
  const pill = (pop, body, title) => `<button class="studio-pill" data-action="studio-pop" data-pop="${pop}" title="${title}" aria-haspopup="dialog">${body}</button>`;
  const model = video ? (current ? current.label.split(' · ').slice(1).join(' · ') || current.label : '未配置视频渠道') : data.image.model || '未配置生图渠道';
  return `${pill('model', `${glyph('cube', 15)}<span>${escape(model)}</span>${glyph('down', 13)}`, '选择模型')}${pill('frame', `${shape(draft.aspectRatio)}<span>${escape(draft.aspectRatio)}${video && current ? `<em>·</em>${escape(draft.resolution)}` : ''}</span>`, '画幅和分辨率')}${video && current ? pill('duration', `${glyph('timer', 15)}<span>${Number(draft.duration)} 秒</span>`, '视频时长') : ''}${limit() > 0 ? `<button class="studio-pill icon-only" data-action="studio-at" title="引用参考图">${glyph('at', 16)}</button>` : ''}`;
}
function hintHTML() {
  const video = draft.kind === 'video', current = channel();
  const text = video ? (!data.channels.length ? '还没有可用的视频渠道，先到“接口设置”添加视频方案。' : current.unavailable ? current.error : '') : (!data.image.configured ? '还没有配置生图渠道，先到“接口设置”添加。' : '');
  return text ? `${ctx.icon('alert', 13)}${ctx.escape(text)}` : '';
}
export function composerBox() {
  return `<div class="studio-box ${expanded ? 'expanded' : ''}"><button class="studio-expand" data-action="studio-expand" title="${expanded ? '收起输入框' : '放大输入框'}" aria-label="${expanded ? '收起输入框' : '放大输入框'}">${ctx.icon(expanded ? 'shrink' : 'expand', 15)}</button><div class="studio-input"><div class="studio-refs">${refsHTML()}</div><div id="studio-prompt" class="studio-editor ${draft.prompt ? '' : 'is-empty'}" contenteditable="true" role="textbox" aria-multiline="true" aria-label="提示词" spellcheck="false" data-placeholder="${placeholder()}">${editorHTML()}</div></div>
<p class="studio-hint">${hintHTML()}</p>
<div class="studio-bar"><div class="studio-bar-left">${barHTML()}</div><span class="spacer"></span><button class="studio-send" data-action="studio-generate" title="生成（Ctrl / ⌘ + 回车）。按厂商价格扣费" aria-label="生成" ${ready() && !uploading && draft.prompt.trim() ? '' : 'disabled'}>${glyph('up', 18)}</button></div>
</div>`;
}
function createHTML() {
  const { icon } = ctx, video = draft.kind === 'video';
  return `<div class="studio-composer" data-studio-drop><div class="studio-tabs" role="tablist" data-kind="${draft.kind}"><i class="studio-tab-pill"></i><button role="tab" class="${video ? 'active' : ''}" aria-selected="${video}" data-action="studio-kind" data-kind="video">${icon('film', 14)}视频</button><button role="tab" class="${video ? '' : 'active'}" aria-selected="${!video}" data-action="studio-kind" data-kind="image">${icon('image', 14)}图片</button></div>
${composerBox().replace(/<\/div>$/, `<div class="studio-drop-cover" aria-hidden="true">${icon('upload', 20)}<strong>松开添加为参考图</strong></div></div>`)}</div>
<div class="studio-feed" id="studio-feed">${data.items.length ? data.items.map(item => card(item)).join('') : emptyFeed()}</div>`;
}
const canvasHTML = () => ctx.canvas.listHTML();
export function studioPage() {
  if (!data) return `<section class="studio-page"><h1 class="studio-title">自由创作</h1></section>`;
  return `<section class="studio-page"><h1 class="studio-title">自由创作</h1><div class="studio-mode" role="tablist" data-mode="${mode}"><i class="studio-mode-pill"></i><button role="tab" class="${mode === 'create' ? 'active' : ''}" data-action="studio-mode" data-mode="create">创作</button><button role="tab" class="${mode === 'canvas' ? 'active' : ''}" data-action="studio-mode" data-mode="canvas">画布</button></div><div class="studio-stage">${mode === 'canvas' ? canvasHTML() : createHTML()}</div></section>`;
}
// 局部重画：参考图条、底部一排按钮、生成按钮。输入框本身不动。
export function paint({ refs = true, bar = true, editor = false } = {}) {
  if (refs) { const strip = $('.studio-refs'); if (strip) strip.innerHTML = refsHTML(); }
  if (bar) { const left = $('.studio-bar-left'); if (left) left.innerHTML = barHTML(); const hint = $('.studio-hint'); if (hint) hint.innerHTML = hintHTML(); }
  const input = $('#studio-prompt');
  if (input) { if (editor) input.innerHTML = editorHTML(); input.dataset.placeholder = placeholder(); input.classList.toggle('is-empty', !draft.prompt); }
  const send = $('.studio-send'); if (send) send.disabled = !(ready() && !uploading && draft.prompt.trim());
}

// ---- 参考图：选择、拖入、粘贴 ----
const isImage = file => ['image/png', 'image/jpeg', 'image/webp'].includes(file.type);
const picker = document.createElement('input'); picker.type = 'file'; picker.accept = 'image/png,image/jpeg,image/webp'; picker.multiple = true; picker.hidden = true;
document.body.append(picker);
picker.addEventListener('change', () => { const files = [...picker.files]; picker.value = ''; addFiles(files); });

export async function addFiles(files) {
  const images = files.filter(isImage);
  if (host) { const usable = files.filter(file => isImage(file) || isMedia(file)); return usable.length ? host.addFiles(usable) : ctx.notify('只能添加图片（PNG、JPEG、WebP）、音频或视频', true); }
  if (mode !== 'create') return;
  if (!images.length) return ctx.notify('参考图须为 PNG、JPEG 或 WebP 图片', true);
  const room = limit() - draft.refs.length - uploading;
  if (room <= 0) return ctx.notify(limit() ? `最多带 ${limit()} 张参考图` : '当前渠道不支持参考图', true);
  if (images.length > room) ctx.notify(`最多带 ${limit()} 张参考图，只添加了前 ${room} 张`, true);
  for (const file of images.slice(0, room)) {
    if (file.size > 15 * 1024 * 1024) { ctx.notify('请使用 15MB 以内的图片', true); continue; }
    uploading++; paint({ bar: false });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      draft.refs.push(await ctx.api('/api/studio/references', { method: 'POST', body: { base64: btoa(binary), name: file.name } }));
    } catch (error) { ctx.notify(error.message, true); }
    finally { uploading--; paint(); const added = $('.studio-refs')?.querySelectorAll('.studio-ref'); added?.[added.length - 1]?.classList.add('is-new'); }
  }
}
export const studioWantsDrop = event => visible() && (mode === 'create' || host) && [...(event.dataTransfer?.items || [])].some(item => item.kind === 'file' && (/^image\/(png|jpeg|webp)$/.test(item.type) || (host && /^(audio|video)\//.test(item.type))));
export function studioDragging(on) { if (host) return; $('[data-studio-drop]')?.classList.toggle('is-dragging', on); }
document.addEventListener('paste', event => {
  if (!visible() || ctx.state.modal) return;
  const files = [...(event.clipboardData?.files || [])].filter(file => isImage(file) || (host && isMedia(file)));
  if (files.length) { event.preventDefault(); addFiles(files); return; }
  if (host && !event.target.closest?.('#studio-prompt')) return;
  // 文字一律按纯文本贴进输入框，不带网页上的格式。
  if (event.target.closest?.('#studio-prompt')) { event.preventDefault(); insertText(event.clipboardData?.getData('text/plain') || ''); }
});
// 移除一段参考音频，和参考图一样后面的往前补位。
export function removeAudio(index) {
  draft.audios.splice(index, 1); const removed = index + 1;
  draft.prompt = draft.prompt.replace(/@音频(\d+)( ?)/g, (whole, digits, space) => { const n = Number(digits); return n === removed ? '' : n > removed ? `@音频${n - 1}${space}` : whole; });
}
// 移除一张参考图后，后面的图往前补位，提示词里的编号跟着改。
export function removeRef(index) {
  draft.refs.splice(index, 1); const removed = index + 1;
  draft.prompt = draft.prompt.replace(/@图(\d+)( ?)/g, (whole, digits, space) => { const n = Number(digits); return n === removed ? '' : n > removed ? `@图${n - 1}${space}` : whole; });
}

// ---- 输入框：文字和缩略图标签混排 ----
function serialize(node) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) out += child.nodeValue.replaceAll(ZW, '');
    else if (child.classList?.contains('studio-at')) out += child.dataset.audio ? `@音频${child.dataset.audio} ` : `@图${child.dataset.index} `;
    else if (child.nodeName === 'BR') out += '\n';
    else { if (/^(DIV|P)$/.test(child.nodeName) && out && !out.endsWith('\n')) out += '\n'; out += serialize(child); }
  }
  return out;
}
export function sync() {
  const input = $('#studio-prompt'); if (!input) return;
  let text = serialize(input); if (!text.trim() && !input.querySelector('.studio-at')) { text = ''; if (input.innerHTML) input.innerHTML = ''; }
  draft.prompt = text.slice(0, 8000); input.classList.toggle('is-empty', !draft.prompt);
  const send = $('.studio-send'); if (send) send.disabled = !(ready() && !uploading && draft.prompt.trim());
  host?.change?.();
}
let lastRange = null;
document.addEventListener('selectionchange', () => { const selection = getSelection(), input = $('#studio-prompt'); if (input && selection.rangeCount && input.contains(selection.anchorNode)) lastRange = selection.getRangeAt(0).cloneRange(); });
function caretRange() {
  const input = $('#studio-prompt'); if (!input) return null;
  if (lastRange && input.contains(lastRange.startContainer)) return lastRange;
  const range = document.createRange(); range.selectNodeContents(input); range.collapse(false); return range;
}
function place(range, nodes) {
  const input = $('#studio-prompt'); range.deleteContents();
  const fragment = document.createDocumentFragment(); for (const node of nodes) fragment.append(node);
  const last = nodes.at(-1); range.insertNode(fragment);
  const next = document.createRange(); next.setStartAfter(last); next.collapse(true);
  input.focus({ preventScroll: true }); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(next); lastRange = next.cloneRange();
  sync();
}
function insertText(text) { const range = caretRange(); if (range && text) place(range, [document.createTextNode(text)]); }
function insertChip(index, range = caretRange(), audio = false) {
  if (!range || !(audio ? draft.audios : draft.refs)[index - 1]) return;
  const holder = document.createElement('div'); holder.innerHTML = audio ? audioChipHTML(index) : chipHTML(index);
  const chip = holder.firstElementChild; chip.classList.add('is-new');
  place(range, [chip, document.createTextNode(ZW)]);
}

const menu = document.createElement('div'); menu.className = 'mention-menu studio-mention-menu'; menu.hidden = true; menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', '选择要引用的参考图');
document.body.append(menu);
let matches = [], chosen = 0, queryRange = null;
function hideMenu() { menu.hidden = true; }
function drawMenu(anchor) {
  menu.innerHTML = matches.length ? matches.map((ref, index) => `<button type="button" role="option" data-studio-mention="${index}" aria-selected="${index === chosen}" class="${index === chosen ? 'active' : ''}">${ref.audio ? `<i class="studio-mention-wave">${ctx.icon('wave', 15)}</i><span>音频${ref.index}</span>` : `<img src="${ctx.escape(ref.url)}" alt=""><span>图${ref.index}</span>`}</button>`).join('') : `<p>${draft.refs.length || draft.audios.length ? '没有这个素材' : '先添加参考图：点左边的 +，或把图片拖进来、粘贴进来'}</p>`;
  menu.hidden = false;
  if (anchor) { const width = 220; menu.style.width = `${width}px`; menu.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - width - 12))}px`; menu.style.top = `${Math.max(12, Math.min(anchor.bottom + 8, innerHeight - Math.min(menu.scrollHeight, 230) - 16))}px`; }
}
function updateMenu() {
  const selection = getSelection(), input = $('#studio-prompt');
  if (!input || !selection.rangeCount || !selection.isCollapsed || selection.anchorNode?.nodeType !== 3 || !input.contains(selection.anchorNode)) return hideMenu();
  const node = selection.anchorNode, offset = selection.anchorOffset, text = node.nodeValue.slice(0, offset), at = text.lastIndexOf('@');
  if (at < 0) return hideMenu();
  const query = text.slice(at + 1);
  if (query.length > 4 || /[\s@，。！？；：,!?;:]/.test(query)) return hideMenu();
  queryRange = document.createRange(); queryRange.setStart(node, at); queryRange.setEnd(node, offset); chosen = 0;
  matches = [...draft.refs.map((ref, index) => ({ ...ref, index: index + 1 })).filter(ref => `图${ref.index}`.includes(query) || String(ref.index).startsWith(query)),
    ...(draft.kind === 'video' ? draft.audios : []).map((audio, index) => ({ ...audio, audio: true, index: index + 1 })).filter(audio => `音频${audio.index}`.includes(query) || String(audio.index).startsWith(query))];
  const rect = queryRange.getBoundingClientRect(); drawMenu(rect.width || rect.height ? rect : input.getBoundingClientRect());
}
function chooseMention(index) { const ref = matches[index]; if (!ref) return; const range = queryRange || caretRange(); hideMenu(); insertChip(ref.index, range, ref.audio); queryRange = null; }
document.addEventListener('input', event => { if (event.target.id === 'studio-prompt') { sync(); updateMenu(); } });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && pop) { event.preventDefault(); event.stopImmediatePropagation(); closePop(); return; }
  if (event.target.id !== 'studio-prompt' || event.isComposing) return;
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); $('.studio-send')?.click(); return; }
  if (!menu.hidden) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); hideMenu(); return; }
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && matches.length) { event.preventDefault(); chosen = (chosen + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length; drawMenu(); return; }
    if (event.key === 'Enter' && matches.length) { event.preventDefault(); chooseMention(chosen); return; }
  }
  // 标签后面跟着一个看不见的占位符，退格时把标签和它一起删掉。
  if (event.key === 'Backspace') {
    const selection = getSelection(); if (!selection.isCollapsed) return;
    const node = selection.anchorNode, offset = selection.anchorOffset;
    let chip = null;
    if (node.nodeType === 3 && node.nodeValue.slice(0, offset).replaceAll(ZW, '') === '' && node.previousSibling?.classList?.contains('studio-at')) chip = node.previousSibling;
    else if (node === event.target) {
      let before = node.childNodes[offset - 1];
      while (before?.nodeType === 3 && before.nodeValue.replaceAll(ZW, '') === '') before = before.previousSibling;
      if (before?.classList?.contains('studio-at')) chip = before;
    }
    if (!chip) return;
    event.preventDefault();
    if (node.nodeType === 3) node.nodeValue = node.nodeValue.slice(offset); else if (chip.nextSibling?.nodeType === 3 && chip.nextSibling.nodeValue.replaceAll(ZW, '') === '') chip.nextSibling.remove();
    const range = document.createRange(); range.setStartBefore(chip); range.collapse(true); chip.remove();
    selection.removeAllRanges(); selection.addRange(range); sync();
  }
}, true);
menu.addEventListener('pointerdown', event => event.preventDefault());
menu.addEventListener('click', event => { const button = event.target.closest('[data-studio-mention]'); if (button) chooseMention(Number(button.dataset.studioMention)); });
document.addEventListener('pointerdown', event => { if (!event.target.closest?.('.studio-mention-menu,[data-action="studio-at"]')) hideMenu(); if (pop && !event.target.closest?.('.studio-pop,[data-action="studio-pop"]')) closePop(); }, true);

// ---- 悬停预览 ----
const peek = document.createElement('div'); peek.className = 'studio-peek'; peek.hidden = true; document.body.append(peek);
let peekTimer = null;
function hidePeek() { clearTimeout(peekTimer); peek.classList.remove('open'); peekTimer = setTimeout(() => { peek.hidden = true; }, 160); }
document.addEventListener('mouseover', event => {
  const target = event.target.closest?.('[data-peek]'); if (!target || !visible()) return;
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => {
    if (!target.isConnected) return;
    peek.innerHTML = `<img src="${ctx.escape(target.dataset.peek)}" alt="">`; peek.hidden = false;
    const rect = target.getBoundingClientRect(), size = 208, above = rect.top > size + 24;
    peek.style.left = `${Math.max(12, Math.min(rect.left + rect.width / 2 - size / 2, innerWidth - size - 12))}px`;
    peek.style.top = `${above ? rect.top - size - 10 : rect.bottom + 10}px`; peek.dataset.side = above ? 'above' : 'below';
    requestAnimationFrame(() => peek.classList.add('open'));
  }, 140);
});
document.addEventListener('mouseout', event => { if (event.target.closest?.('[data-peek]') && !event.relatedTarget?.closest?.('[data-peek]')) hidePeek(); });
document.addEventListener('click', event => { if (event.target.closest?.('[data-peek]')) hidePeek(); }, true);

// ---- 弹出面板：模型、画幅、时长 ----
let pop = null, popKind = '';
function closePop() { if (!pop) return; const node = pop; pop = null; popKind = ''; document.querySelectorAll('.studio-pill.open').forEach(button => button.classList.remove('open')); node.classList.remove('open'); setTimeout(() => node.remove(), 170); }
function popHTML(kind) {
  const { escape } = ctx, video = draft.kind === 'video', current = channel();
  if (kind === 'model') {
    if (!video) return `<div class="studio-pop-title">生图模型</div><div class="studio-option active"><span class="studio-option-icon">${glyph('cube', 17)}</span><span><strong>${escape(data.image.model || '未配置')}</strong><small>${escape(data.image.label.split(' · ')[0])}</small></span>${glyph('check', 16)}</div><p class="studio-pop-note">生图用“接口设置”里当前启用的方案，换模型请到那里切换。</p>`;
    if (!data.channels.length) return `<p class="studio-pop-note">还没有可用的视频渠道，先到“接口设置”添加视频方案。</p>`;
    return `<div class="studio-pop-title">视频模型</div><div class="studio-options">${data.channels.map(item => { const [name, ...rest] = item.label.split(' · '); return `<button class="studio-option ${item.value === current?.value ? 'active' : ''}" data-action="studio-set" data-key="channel" data-value="${escape(item.value)}"><span class="studio-option-icon">${glyph('cube', 17)}</span><span><strong>${escape(rest.join(' · ') || name)}</strong><small>${escape(name)} · ${item.minDuration}–${item.maxDuration} 秒 · ${escape(item.resolutions.join(' / '))}</small></span>${item.value === current?.value ? glyph('check', 16) : ''}</button>`; }).join('')}</div>`;
  }
  if (kind === 'frame') return `<div class="studio-pop-title">画幅</div><div class="studio-tiles">${data.ratios.map(ratio => `<button class="studio-tile ${ratio === draft.aspectRatio ? 'active' : ''}" data-action="studio-set" data-key="aspectRatio" data-value="${ratio}">${shape(ratio)}<span>${ratio}</span></button>`).join('')}</div>${video && current ? `<div class="studio-pop-title">分辨率</div><div class="studio-tiles flat">${current.resolutions.map(value => `<button class="studio-tile ${value === draft.resolution ? 'active' : ''}" data-action="studio-set" data-key="resolution" data-value="${escape(value)}"><span>${escape(value)}</span></button>`).join('')}</div>` : ''}`;
  if (kind === 'duration' && current) return `<div class="studio-pop-title">时长</div><div class="studio-duration"><div class="studio-range"><input type="range" id="studio-duration-range" min="${current.minDuration}" max="${current.maxDuration}" step="1" value="${Number(draft.duration)}" aria-label="时长"><div><span>${current.minDuration}</span><span>${current.maxDuration}</span></div></div><label class="studio-seconds"><input type="number" id="studio-duration-number" min="${current.minDuration}" max="${current.maxDuration}" step="1" value="${Number(draft.duration)}" aria-label="秒数"><span>秒</span></label></div>`;
  return '';
}
function fillRange() { const range = $('#studio-duration-range'); if (range) range.style.setProperty('--fill', `${(range.value - range.min) / Math.max(1, range.max - range.min) * 100}%`); }
function openPop(kind, button) {
  if (popKind === kind) return closePop();
  closePop(); hideMenu();
  const node = document.createElement('div'); node.className = `studio-pop studio-pop-${kind}`; node.setAttribute('role', 'dialog'); node.innerHTML = popHTML(kind);
  document.body.append(node); pop = node; popKind = kind; button.classList.add('open');
  const rect = button.getBoundingClientRect(), width = node.offsetWidth, height = node.offsetHeight, below = rect.bottom + 10 + height < innerHeight - 8 || rect.top < height + 20;
  node.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
  node.style.top = `${below ? rect.bottom + 10 : rect.top - height - 10}px`; node.dataset.side = below ? 'below' : 'above';
  fillRange(); requestAnimationFrame(() => node.classList.add('open'));
}
function setDuration(value, source) {
  const current = channel(); if (!current || !Number.isFinite(value)) return;
  draft.duration = Math.max(current.minDuration, Math.min(current.maxDuration, Math.round(value))); remember();
  const range = $('#studio-duration-range'), number = $('#studio-duration-number');
  if (range && source !== range) range.value = draft.duration; if (number && source !== number) number.value = draft.duration;
  fillRange(); const label = $('[data-pop="duration"] span'); if (label) label.textContent = `${draft.duration} 秒`;
}
document.addEventListener('input', event => { if (event.target.id === 'studio-duration-range') setDuration(Number(event.target.value), event.target); else if (event.target.id === 'studio-duration-number' && event.target.value !== '') setDuration(Number(event.target.value), event.target); });
document.addEventListener('change', event => { if (event.target.id === 'studio-duration-number') event.target.value = draft.duration; });
addEventListener('resize', closePop);
addEventListener('scroll', () => { closePop(); hideMenu(); hidePeek(); }, { passive: true });

// ---- 按钮 ----
export async function studioAction(action, button) {
  const { api, notify } = ctx;
  if (action === 'studio-expand') {
    expanded = !expanded; const box = button.closest('.studio-box'); box?.classList.toggle('expanded', expanded);
    button.innerHTML = ctx.icon(expanded ? 'shrink' : 'expand', 15); button.title = button.ariaLabel = expanded ? '收起输入框' : '放大输入框';
    host?.resize?.(); $('#studio-prompt')?.focus({ preventScroll: true }); return;
  }
  if (action === 'studio-mode') {
    const next = button.dataset.mode === 'canvas' ? 'canvas' : 'create'; if (next === mode) return;
    mode = next; closePop(); hideMenu();
    if (mode === 'canvas') await ctx.canvas.loadList();
    const toggle = $('.studio-mode'); toggle.dataset.mode = mode; toggle.querySelectorAll('button').forEach(item => item.classList.toggle('active', item.dataset.mode === mode));
    const stage = $('.studio-stage'); stage.innerHTML = mode === 'canvas' ? canvasHTML() : createHTML(); lastJSON = JSON.stringify(data.items); fade(stage, 10);
    return;
  }
  if (action === 'studio-kind') {
    const next = button.dataset.kind === 'image' ? 'image' : 'video'; if (next === draft.kind) return;
    draft.kind = next; closePop(); hideMenu();
    let editor = false;
    if (draft.refs.length > limit()) { while (draft.refs.length > limit()) removeRef(draft.refs.length - 1); editor = true; notify('这个渠道带不了这么多参考图，多出的已移除', true); }
    const tabs = $('.studio-tabs'); tabs.dataset.kind = next; tabs.querySelectorAll('button').forEach(item => { const on = item.dataset.kind === next; item.classList.toggle('active', on); item.setAttribute('aria-selected', on); });
    remember(); paint({ editor }); fade($('.studio-bar-left'), 4);
    return;
  }
  if (action === 'studio-pop') return openPop(button.dataset.pop, button);
  if (action === 'studio-set') {
    const key = button.dataset.key, value = button.dataset.value;
    if (key === 'channel') { draft.channel = value; draft.duration = 0; draft.resolution = ''; settle(); remember(); closePop(); paint({ refs: false }); fade($('.studio-bar-left'), 4); return; }
    draft[key] = value; remember();
    button.parentElement.querySelectorAll('.studio-tile').forEach(tile => tile.classList.toggle('active', tile === button));
    const open = popKind; paint({ refs: false }); document.querySelector(`[data-pop="${open}"]`)?.classList.add('open');
    return;
  }
  if (action === 'studio-add-ref') { picker.click(); return; }
  if (action === 'studio-at') {
    const input = $('#studio-prompt'); input.focus({ preventScroll: true }); queryRange = null; chosen = 0;
    matches = draft.refs.map((ref, index) => ({ ...ref, index: index + 1 }));
    if (!menu.hidden) return hideMenu();
    drawMenu(button.getBoundingClientRect()); return;
  }
  if (action === 'studio-remove-ref' && host) { hidePeek(); return host.removeRef(Number(button.dataset.index)); }
  if (action === 'studio-remove-audio' && host) return host.removeAudio(Number(button.dataset.index));
  if (action === 'studio-generate' && host) { sync(); if (!draft.prompt.trim()) { $('#studio-prompt')?.focus(); throw new Error('请先写提示词'); } button.disabled = true; button.classList.add('busy'); try { setData(await host.generate()); } finally { button.classList.remove('busy'); paint({ refs: false, bar: false }); } if (!timer) timer = setInterval(refresh, 2000); return; }
  if (action === 'studio-remove-ref') { removeRef(Number(button.dataset.index)); hidePeek(); paint({ editor: true }); return; }
  if (action === 'studio-generate') {
    sync();
    if (!draft.prompt.trim()) { $('#studio-prompt')?.focus(); throw new Error('请先写提示词'); }
    button.disabled = true; button.classList.add('busy');
    try { setData(await api('/api/studio/items', { method: 'POST', body: { kind: draft.kind, prompt: draft.prompt, refIds: draft.refs.map(ref => ref.id), channel: draft.channel, duration: draft.duration, resolution: draft.resolution, aspectRatio: draft.aspectRatio } })); }
    finally { button.classList.remove('busy'); paint({ refs: false, bar: false }); }
    draft.prompt = ''; draft.refs = []; paint({ editor: true }); updateFeed();
    notify(draft.kind === 'video' ? '已提交，视频生成需要几分钟，可以继续写下一条' : '已提交，图片马上就好');
    if (!timer) timer = setInterval(refresh, 2000);
    return;
  }
  const id = button.dataset.id, item = data?.items.find(entry => entry.id === id);
  if (action === 'studio-reuse' && item) {
    Object.assign(draft, { kind: item.kind, prompt: item.prompt.replace(/@音频\d+ ?/g, ''), aspectRatio: item.aspectRatio, audios: [], refs: item.refs.filter(ref => !ref.missing).map(ref => ({ id: ref.id, url: ref.url })) });
    if (item.audios?.length) notify('参考音频只能在画布里连接，这次没有带上', true);
    if (item.kind === 'video') Object.assign(draft, { channel: item.channel, duration: item.duration, resolution: item.resolution });
    if (item.refs.some(ref => ref.missing)) { draft.prompt = draft.prompt.replace(/@图\d+ ?/g, ''); notify('原来的参考图已清理，请重新添加', true); }
    settle();
    const tabs = $('.studio-tabs'); if (tabs) { tabs.dataset.kind = draft.kind; tabs.querySelectorAll('button').forEach(tab => tab.classList.toggle('active', tab.dataset.kind === draft.kind)); }
    paint({ editor: true }); window.scrollTo({ top: 0, behavior: calm() ? 'instant' : 'smooth' }); $('#studio-prompt')?.focus({ preventScroll: true });
    return;
  }
  if (action === 'studio-resume') { setData(await api(`/api/studio/items/${encodeURIComponent(id)}/resume`, { method: 'POST' })); updateFeed(); notify('正在接着查询原任务'); return; }
  if (action === 'studio-delete') {
    if (!confirm(item?.result ? '删除这条记录和生成的文件？删除后无法恢复。' : '删除这条记录？')) return;
    setData(await api(`/api/studio/items/${encodeURIComponent(id)}`, { method: 'DELETE' })); updateFeed(); notify('已删除');
  }
}
