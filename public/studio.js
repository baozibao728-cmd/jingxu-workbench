// 自由创作：不拆剧本和分镜，一段提示词加参考图直接生成视频或图片。
// 输入区的内容记在 draft 里，整页重画后原样还原；结果列表按条更新，不打断正在播放的视频。
let ctx = null, data = null, timer = null, uploading = 0, lastJSON = '';
const draft = { kind: 'video', prompt: '', refs: [], channel: '', duration: 0, resolution: '', aspectRatio: '16:9' };
try { Object.assign(draft, JSON.parse(localStorage.getItem('drama-studio') || '{}')); } catch {}
draft.prompt = ''; draft.refs = [];
const remember = () => { try { localStorage.setItem('drama-studio', JSON.stringify({ kind: draft.kind, channel: draft.channel, duration: draft.duration, resolution: draft.resolution, aspectRatio: draft.aspectRatio })); } catch {} };
const activeJob = job => ['pending', 'submitting', 'queued', 'running', 'downloading'].includes(job?.state);
const stateLabel = { pending: '等待开始', submitting: '正在提交', queued: '排队中', running: '生成中', downloading: '下载中', completed: '已完成', failed: '失败', unknown: '待核对' };
const visible = () => ctx?.state.screen === 'studio';

export function initStudio(context) { ctx = context; }

function channel() { return data?.channels.find(item => item.value === draft.channel) || data?.channels[0] || null; }
function limit() { return draft.kind === 'image' ? data?.image.maxReference ?? 0 : channel()?.maxReference ?? 9; }
// 渠道变了以后，把时长和分辨率拉回这个模型支持的范围。
function settle() {
  const current = channel(); if (!current) return;
  draft.channel = current.value;
  if (!(draft.duration >= current.minDuration && draft.duration <= current.maxDuration)) draft.duration = current.defaultDuration;
  if (!current.resolutions.includes(draft.resolution)) draft.resolution = current.defaultResolution;
  if (!(data.ratios || []).includes(draft.aspectRatio)) draft.aspectRatio = '16:9';
}

export async function openStudio() {
  data = await ctx.api('/api/studio'); lastJSON = JSON.stringify(data.items); settle();
  clearInterval(timer); timer = setInterval(refresh, 2000);
}

async function refresh() {
  if (!visible()) { clearInterval(timer); timer = null; return; }
  try { const next = await ctx.api('/api/studio'); data = next; updateFeed(); } catch {}
}

function updateFeed() {
  const json = JSON.stringify(data.items); if (json === lastJSON) return; lastJSON = json;
  const feed = document.querySelector('#studio-feed'); if (!feed) return;
  if (!data.items.length) { feed.innerHTML = emptyFeed(); return; }
  feed.querySelector('.studio-empty')?.remove();
  const existing = new Map([...feed.querySelectorAll('[data-studio-item]')].map(node => [node.dataset.studioItem, node]));
  let previous = null;
  for (const item of data.items) {
    const signature = JSON.stringify(item); let node = existing.get(item.id);
    if (!node || node.dataset.signature !== signature) {
      const holder = document.createElement('div'); holder.innerHTML = card(item); const fresh = holder.firstElementChild;
      if (node) node.replaceWith(fresh); node = fresh;
    }
    existing.delete(item.id);
    if (previous ? previous.nextElementSibling !== node : feed.firstElementChild !== node) previous ? previous.after(node) : feed.prepend(node);
    previous = node;
  }
  for (const node of existing.values()) node.remove();
}

const emptyFeed = () => `<div class="studio-empty">${ctx.icon('sparkle', 22)}<p>还没有作品。写一段提示词，点“生成”试试。</p></div>`;

function card(item) {
  const { escape, icon } = ctx, job = item.job, running = activeJob(job), failed = ['failed', 'unknown'].includes(job.state);
  const media = item.result
    ? item.kind === 'video' ? `<video src="${escape(item.result.url)}" controls preload="metadata" playsinline></video>` : `<img src="${escape(item.result.url)}" alt="生成的图片" data-zoom-image tabindex="0">`
    : `<div class="studio-pending ${failed ? 'failed' : ''}">${running ? icon('refresh', 20, 'spin') : icon(failed ? 'alert' : 'clock', 20)}<strong>${escape(running && job.message ? job.message : stateLabel[job.state] || '')}</strong>${running && job.progress ? `<span>${Number(job.progress)}%</span>` : ''}${failed ? `<p>${escape(job.error || '任务失败')}</p>` : ''}</div>`;
  const meta = [item.kind === 'video' ? '视频' : '图片', item.model, item.kind === 'video' ? `${Number(item.duration)} 秒` : '', item.kind === 'video' ? item.resolution : '', item.aspectRatio, new Date(item.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })].filter(Boolean);
  return `<article class="studio-card ${item.aspectRatio === '9:16' ? 'portrait' : ''}" data-studio-item="${escape(item.id)}" data-signature="${escape(JSON.stringify(item))}"><div class="studio-media ${item.result ? '' : 'waiting'}">${media}</div><div class="studio-info"><p class="studio-prompt-text">${escape(item.prompt)}</p>${item.refs.length ? `<div class="studio-card-refs">${item.refs.map(ref => `<img src="${escape(ref.url)}" alt="${escape(ref.name)}" title="${escape(ref.name)}" loading="lazy">`).join('')}</div>` : ''}<div class="studio-meta">${meta.map(text => `<span>${escape(text)}</span>`).join('')}</div><div class="studio-actions"><button class="small" data-action="studio-reuse" data-id="${escape(item.id)}" title="把提示词、参考图和参数放回输入框">${icon('edit', 13)}再次编辑</button>${item.result ? `<a class="button-link small" href="${escape(item.result.url)}" download="${escape(item.result.file)}">${icon('download', 13)}下载</a>` : ''}${job.canResume ? `<button class="small" data-action="studio-resume" data-id="${escape(item.id)}" title="接着查询原来的任务，不会重新提交和扣费">${icon('clock', 13)}继续查询</button>` : ''}<span class="spacer"></span><button class="small ghost icon-button" data-action="studio-delete" data-id="${escape(item.id)}" title="删除这条记录" ${running ? 'disabled' : ''}>${icon('trash', 14)}</button></div></div></article>`;
}

export function studioPage() {
  const { escape, icon } = ctx;
  if (!data) return `<section class="studio-page"><div class="studio-hero"><h1>自由创作</h1></div></section>`;
  const video = draft.kind === 'video', current = channel(), max = limit(), ready = video ? Boolean(current) && !current.unavailable : data.image.configured;
  const option = (value, label, selected) => `<option value="${escape(value)}" ${selected ? 'selected' : ''}>${escape(label)}</option>`;
  const durations = current ? Array.from({ length: current.maxDuration - current.minDuration + 1 }, (_, index) => current.minDuration + index) : [];
  const hint = video
    ? !data.channels.length ? '还没有可用的视频渠道，先到“设置 → 接口配置”添加视频方案。' : current.unavailable ? current.error : ''
    : !data.image.configured ? '还没有配置生图渠道，先到“设置 → 接口配置”添加。' : '';
  const controls = video
    ? `<select id="studio-channel" aria-label="视频模型" title="视频渠道和模型">${data.channels.map(item => option(item.value, item.label, item.value === current?.value)).join('') || '<option value="">未配置视频渠道</option>'}</select><select id="studio-ratio" aria-label="画幅">${data.ratios.map(ratio => option(ratio, ratio, ratio === draft.aspectRatio)).join('')}</select>${current ? `<select id="studio-resolution" aria-label="分辨率">${current.resolutions.map(value => option(value, value, value === draft.resolution)).join('')}</select><select id="studio-duration" aria-label="时长">${durations.map(value => option(value, `${value} 秒`, value === Number(draft.duration))).join('')}</select>` : ''}`
    : `<span class="studio-chip" title="生图用“设置 → 接口配置”里当前启用的生图方案">${escape(data.image.label)}</span><select id="studio-ratio" aria-label="画幅">${data.ratios.map(ratio => option(ratio, ratio, ratio === draft.aspectRatio)).join('')}</select>`;
  const refs = draft.refs.map((ref, index) => `<div class="studio-ref" title="点一下把 @图${index + 1} 插入提示词"><button class="studio-ref-pick" data-action="studio-mention" data-index="${index + 1}"><img src="${escape(ref.url)}" alt="图${index + 1}"><span>图${index + 1}</span></button><button class="studio-ref-remove" data-action="studio-remove-ref" data-index="${index}" aria-label="移除图${index + 1}">${icon('close', 11)}</button></div>`).join('');
  const add = max > 0 ? `<button class="studio-ref-add" data-action="studio-add-ref" title="选择图片，也可以直接拖进来或粘贴" ${draft.refs.length >= max ? 'disabled' : ''}>${uploading ? icon('refresh', 16, 'spin') : icon('plus', 16)}<span>${uploading ? '上传中' : '参考图'}</span></button>` : '';
  return `<section class="studio-page"><div class="studio-hero"><div><h1>自由创作</h1><p>不用拆剧本和分镜。写一段提示词，配上参考图，直接生成视频或图片。</p></div></div>
<div class="studio-composer" data-studio-drop><div class="studio-tabs" role="tablist"><button role="tab" class="${video ? 'active' : ''}" aria-selected="${video}" data-action="studio-kind" data-kind="video">${icon('film', 14)}视频</button><button role="tab" class="${video ? '' : 'active'}" aria-selected="${!video}" data-action="studio-kind" data-kind="image">${icon('image', 14)}图片</button></div>
<div class="studio-input"><div class="studio-refs">${refs}${add}</div><textarea id="studio-prompt" maxlength="8000" spellcheck="false" placeholder="${max > 0 ? `描述你想要的画面。可以拖入或粘贴图片作参考（最多 ${max} 张），输入 @ 引用某一张图` : '描述你想要的画面。当前生图渠道不支持参考图'}">${escape(draft.prompt)}</textarea></div>
${hint ? `<p class="studio-hint">${icon('alert', 13)}${escape(hint)}</p>` : ''}
<div class="studio-bar">${controls}<span class="spacer"></span><span class="muted small-text studio-count">${draft.prompt.length} / 8000</span><button class="primary" data-action="studio-generate" ${ready && !uploading ? '' : 'disabled'}>${icon('sparkle', 14)}生成</button></div>
<div class="studio-drop-cover" aria-hidden="true">${icon('upload', 22)}<strong>松开添加为参考图</strong></div></div>
<div class="studio-feed-head"><h2>作品</h2><span class="muted small-text">生成会按厂商价格扣费；记录和文件只保存在这台电脑上。</span></div>
<div class="studio-feed" id="studio-feed">${data.items.length ? data.items.map(card).join('') : emptyFeed()}</div></section>`;
}

// ---- 参考图：选择、拖入、粘贴 ----
const isImage = file => ['image/png', 'image/jpeg', 'image/webp'].includes(file.type);
const picker = document.createElement('input'); picker.type = 'file'; picker.accept = 'image/png,image/jpeg,image/webp'; picker.multiple = true; picker.hidden = true;
document.body.append(picker);
picker.addEventListener('change', () => { const files = [...picker.files]; picker.value = ''; addFiles(files); });

export async function addFiles(files) {
  const images = files.filter(isImage);
  if (!images.length) return ctx.notify('参考图须为 PNG、JPEG 或 WebP 图片', true);
  const room = limit() - draft.refs.length - uploading;
  if (room <= 0) return ctx.notify(limit() ? `最多带 ${limit()} 张参考图` : '当前渠道不支持参考图', true);
  if (images.length > room) ctx.notify(`最多带 ${limit()} 张参考图，只添加了前 ${room} 张`, true);
  for (const file of images.slice(0, room)) {
    if (file.size > 15 * 1024 * 1024) { ctx.notify('请使用 15MB 以内的图片', true); continue; }
    uploading++; if (visible()) ctx.render();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      draft.refs.push(await ctx.api('/api/studio/references', { method: 'POST', body: { base64: btoa(binary), name: file.name } }));
    } catch (error) { ctx.notify(error.message, true); }
    finally { uploading--; if (visible()) ctx.render(); }
  }
}

export const studioWantsDrop = event => visible() && [...(event.dataTransfer?.items || [])].some(item => item.kind === 'file' && /^image\/(png|jpeg|webp)$/.test(item.type));
export function studioDragging(on) { document.querySelector('[data-studio-drop]')?.classList.toggle('is-dragging', on); }
document.addEventListener('paste', event => {
  if (!visible() || ctx.state.modal) return;
  const files = [...(event.clipboardData?.files || [])].filter(isImage);
  if (!files.length) return;
  event.preventDefault(); addFiles(files);
});

// ---- 提示词与 @ 引用 ----
function insertMention(index) {
  const input = document.querySelector('#studio-prompt'); if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  input.setRangeText(`@图${index} `, start, input.selectionEnd ?? start, 'end');
  draft.prompt = input.value; input.focus({ preventScroll: true }); syncCount();
}
function syncCount() { const count = document.querySelector('.studio-count'); if (count) count.textContent = `${draft.prompt.length} / 8000`; }
// 移除一张参考图后，后面的图往前补位，提示词里的编号跟着改。
function removeRef(index) {
  draft.refs.splice(index, 1); const removed = index + 1;
  draft.prompt = draft.prompt.replace(/@图(\d+)( ?)/g, (whole, digits, space) => { const n = Number(digits); return n === removed ? '' : n > removed ? `@图${n - 1}${space}` : whole; });
}

const menu = document.createElement('div'); menu.className = 'mention-menu studio-mention-menu'; menu.hidden = true; menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', '选择要引用的参考图');
document.body.append(menu);
let matches = [], chosen = 0, queryStart = -1;
function hideMenu() { menu.hidden = true; }
function drawMenu(input) {
  menu.innerHTML = matches.length ? matches.map((ref, index) => `<button type="button" role="option" data-studio-mention="${index}" aria-selected="${index === chosen}" class="${index === chosen ? 'active' : ''}"><img src="${ctx.escape(ref.url)}" alt=""><span>图${ref.index}</span><small>参考图</small></button>`).join('') : `<p>${draft.refs.length ? '没有这张图，按 Esc 返回' : '先添加参考图：点“参考图”、拖进来或直接粘贴'}</p>`;
  menu.hidden = false;
  const rect = input.getBoundingClientRect(), width = Math.min(300, rect.width);
  menu.style.width = `${width}px`; menu.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
  menu.style.top = `${Math.max(12, Math.min(rect.bottom + 6, innerHeight - Math.min(menu.scrollHeight, 230) - 16))}px`;
}
function updateMenu(input) {
  const caret = input.selectionStart, text = input.value;
  if (caret !== input.selectionEnd) return hideMenu();
  const at = text.lastIndexOf('@', caret - 1); if (at < 0) return hideMenu();
  const query = text.slice(at + 1, caret);
  if (query.length > 4 || /[\s@，。！？；：,!?;:]/.test(query)) return hideMenu();
  queryStart = at; chosen = 0;
  matches = draft.refs.map((ref, index) => ({ ...ref, index: index + 1 })).filter(ref => `图${ref.index}`.includes(query) || String(ref.index).startsWith(query));
  drawMenu(input);
}
function chooseMention(index) {
  const input = document.querySelector('#studio-prompt'), ref = matches[index]; if (!input || !ref || queryStart < 0) return;
  input.setRangeText(`@图${ref.index} `, queryStart, input.selectionStart, 'end');
  draft.prompt = input.value; hideMenu(); input.focus({ preventScroll: true }); syncCount();
}
document.addEventListener('input', event => {
  const target = event.target;
  if (target.id === 'studio-prompt') { draft.prompt = target.value; syncCount(); updateMenu(target); return; }
  if (target.id === 'studio-channel') { draft.channel = target.value; draft.duration = 0; draft.resolution = ''; settle(); remember(); ctx.render(); return; }
  if (target.id === 'studio-ratio') { draft.aspectRatio = target.value; remember(); return; }
  if (target.id === 'studio-resolution') { draft.resolution = target.value; remember(); return; }
  if (target.id === 'studio-duration') { draft.duration = Number(target.value); remember(); }
});
document.addEventListener('click', event => { if (event.target.id === 'studio-prompt') updateMenu(event.target); else if (!event.target.closest('.studio-mention-menu')) hideMenu(); });
document.addEventListener('keydown', event => {
  if (event.target.id !== 'studio-prompt' || event.isComposing) return;
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); document.querySelector('[data-action="studio-generate"]')?.click(); return; }
  if (menu.hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); hideMenu(); }
  if (['ArrowDown', 'ArrowUp'].includes(event.key) && matches.length) { event.preventDefault(); chosen = (chosen + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length; drawMenu(event.target); }
  if (event.key === 'Enter' && matches.length) { event.preventDefault(); chooseMention(chosen); }
}, true);
menu.addEventListener('pointerdown', event => event.preventDefault());
menu.addEventListener('click', event => { const button = event.target.closest('[data-studio-mention]'); if (button) chooseMention(Number(button.dataset.studioMention)); });
document.addEventListener('focusout', event => { if (event.target.id === 'studio-prompt') setTimeout(() => { if (document.activeElement?.id !== 'studio-prompt') hideMenu(); }, 120); });

// ---- 按钮 ----
export async function studioAction(action, button) {
  const { api, notify, render } = ctx;
  if (action === 'studio-kind') { draft.kind = button.dataset.kind === 'image' ? 'image' : 'video'; if (draft.refs.length > limit()) { while (draft.refs.length > limit()) removeRef(draft.refs.length - 1); notify('这个渠道带不了这么多参考图，多出的已移除', true); } remember(); render(); return; }
  if (action === 'studio-add-ref') { picker.click(); return; }
  if (action === 'studio-mention') { insertMention(Number(button.dataset.index)); return; }
  if (action === 'studio-remove-ref') { removeRef(Number(button.dataset.index)); render(); return; }
  if (action === 'studio-generate') {
    if (!draft.prompt.trim()) { document.querySelector('#studio-prompt')?.focus(); throw new Error('请先写提示词'); }
    button.disabled = true;
    try {
      data = await api('/api/studio/items', { method: 'POST', body: { kind: draft.kind, prompt: draft.prompt, refIds: draft.refs.map(ref => ref.id), channel: draft.channel, duration: draft.duration, resolution: draft.resolution, aspectRatio: draft.aspectRatio } });
    } finally { button.disabled = false; }
    draft.prompt = ''; draft.refs = []; lastJSON = JSON.stringify(data.items); render();
    notify(draft.kind === 'video' ? '已提交，视频生成需要几分钟，可以继续写下一条' : '已提交，图片马上就好');
    if (!timer) timer = setInterval(refresh, 2000);
    return;
  }
  const id = button.dataset.id, item = data?.items.find(entry => entry.id === id);
  if (action === 'studio-reuse' && item) {
    Object.assign(draft, { kind: item.kind, prompt: item.prompt, aspectRatio: item.aspectRatio, refs: item.refs.filter(ref => !ref.missing).map(ref => ({ id: ref.id, url: ref.url })) });
    if (item.kind === 'video') Object.assign(draft, { channel: item.channel, duration: item.duration, resolution: item.resolution });
    if (item.refs.some(ref => ref.missing)) { draft.prompt = draft.prompt.replace(/@图\d+ ?/g, ''); notify('原来的参考图已清理，请重新添加', true); }
    settle(); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); document.querySelector('#studio-prompt')?.focus({ preventScroll: true });
    return;
  }
  if (action === 'studio-resume') { data = await api(`/api/studio/items/${encodeURIComponent(id)}/resume`, { method: 'POST' }); updateFeed(); notify('正在接着查询原任务'); return; }
  if (action === 'studio-delete') {
    if (!confirm(item?.result ? '删除这条记录和生成的文件？删除后无法恢复。' : '删除这条记录？')) return;
    data = await api(`/api/studio/items/${encodeURIComponent(id)}`, { method: 'DELETE' }); updateFeed(); notify('已删除');
  }
}
