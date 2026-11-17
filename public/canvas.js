// 画布：在一张无限大的画面上摆放图片和视频节点，用连线把图片当参考图接到生成节点上。
// 生成本身走“自由创作”的同一套接口；选中生成节点时，下方的输入框也是同一个，只是内容换成这个节点的。
import { draft, setHost, composerBox, paint, removeRef as dropRef, settle, loadData, studioData, onData, mediaHTML, activeJob } from './studio.js';

let ctx = null, list = [], cv = null, root = null, bound = null, drag = null, space = false, saveTimer = null, menuState = null;
const sel = new Set(), last = { x: 0, y: 0 };
const LABEL = 26, BLANK = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E';
const $ = selector => root?.querySelector(selector);
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), byte => 'abcdefghijklmnopqrstuvwxyz0123456789'[byte % 36]).join('');
const node = id => cv.nodes.find(item => item.id === id);
const height = item => item.w / (item.ratio || 16 / 9);
const sources = target => cv.edges.filter(edge => edge.to === target.id).map(edge => node(edge.from)).filter(Boolean);
const itemOf = item => item.itemId ? studioData()?.items.find(entry => entry.id === item.itemId) : null;
const toWorld = (clientX, clientY) => ({ x: (clientX - cv.view.x) / cv.view.k, y: (clientY - cv.view.y) / cv.view.k });
const ratioOf = text => ({ '9:16': 9 / 16, '1:1': 1 }[text] || 16 / 9);

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
  $('.cv-zoom output').textContent = `${Math.round(k * 100)}%`; if (sel.size > 1) drawSelBox();
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
function bodyHTML(item) {
  const { escape, icon } = ctx;
  if (item.source === 'upload') return `<img src="${escape(item.url || BLANK)}" alt="" draggable="false">`;
  const job = itemOf(item);
  if (job) return mediaHTML(job).replace(' data-zoom-image', '').replace(' tabindex="0"', '');
  if (item.url) return `<img src="${escape(item.url)}" alt="" draggable="false">`;
  return `<div class="cv-blank">${icon(item.type === 'video' ? 'play' : 'image', 30)}</div>`;
}
const bodyKey = item => { const job = itemOf(item); return JSON.stringify([item.url, job?.result?.url || '', job?.job.state || '', job?.job.error || '']); };
function nodeHTML(item, fresh = false) {
  const { escape, icon } = ctx;
  return `<div class="cv-node type-${item.type} ${sel.has(item.id) ? 'selected' : ''} ${fresh ? 'is-new' : ''}" data-node="${item.id}" style="left:${item.x}px;top:${item.y}px;width:${item.w}px"><div class="cv-node-label">${icon(item.type === 'video' ? 'play' : 'image', 12)}<span>${escape(item.label)}</span></div><div class="cv-node-body" data-key="${escape(bodyKey(item))}" style="aspect-ratio:${item.ratio || 16 / 9}">${bodyHTML(item)}</div>${item.type === 'image' ? `<button class="cv-handle" data-handle title="拉出连线，用这张图去生成" aria-label="拉出连线">${icon('plus', 13)}</button>` : ''}</div>`;
}
function drawNodes() { $('.cv-nodes').innerHTML = cv.nodes.map(item => nodeHTML(item)).join(''); drawEdges(); drawGroups(); toggleEmpty(); }
function toggleEmpty() { $('.cv-empty').hidden = cv.nodes.length > 0; }
const anchorOut = item => ({ x: item.x + item.w, y: item.y + LABEL + height(item) / 2 });
const anchorIn = item => ({ x: item.x, y: item.y + LABEL + height(item) / 2 });
const curve = (a, b) => { const bend = Math.max(60, Math.abs(b.x - a.x) / 2); return `M${a.x},${a.y} C${a.x + bend},${a.y} ${b.x - bend},${b.y} ${b.x},${b.y}`; };
const tempEdges = (from, to) => from.map(id => { const d = curve(anchorOut(node(id)), to); return `<path class="lit" d="${d}"/><path class="glow" d="${d}"/>`; }).join('');
function drawEdges(extra = '') {
  $('.cv-edges').innerHTML = cv.edges.map(edge => { const from = node(edge.from), to = node(edge.to); if (!from || !to) return ''; const busy = activeJob(itemOf(to)?.job), lit = sel.has(from.id) || sel.has(to.id); const d = curve(anchorOut(from), anchorIn(to)); return `<path class="${lit ? 'lit' : ''}" d="${d}"/>${busy || lit ? `<path class="glow ${busy ? 'fast' : ''}" d="${d}"/>` : ''}`; }).join('') + extra;
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
function drawSelBox() {
  const box = $('.cv-selbox'), area = sel.size > 1 ? boundsOf([...sel]) : null;
  if (!area) { box.hidden = true; return; }
  const { icon } = ctx, images = [...sel].some(id => node(id)?.type === 'image'), grouped = groupOfSelection(), inverse = 1 / cv.view.k;
  box.hidden = false; box.style.cssText = `left:${area.l - 18}px;top:${area.t - 14}px;width:${area.r - area.l + 36}px;height:${area.b - area.t + 32}px`;
  box.innerHTML = `<div class="cv-seltools" style="transform:scale(${inverse})"><span>已选 ${sel.size} 个</span><button data-action="${grouped ? 'canvas-ungroup' : 'canvas-group'}">${icon('copy', 13)}${grouped ? '解组' : '打组'}</button><button data-action="canvas-delete-selected">${icon('trash', 13)}删除</button></div>${images ? `<button class="cv-handle multi" data-handle-multi style="transform:scale(${inverse})" title="把选中的图片一起连出去" aria-label="一起拉出连线">${icon('plus', 13)}</button>` : ''}`;
}
function paintSelection() {
  for (const element of root.querySelectorAll('.cv-node')) element.classList.toggle('selected', sel.has(element.dataset.node));
  drawEdges(); drawSelBox(); bind();
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
  drawEdges(); if (changed) save();
}
// 图片、视频加载出来后按真实比例调整节点高度。
function watchMedia(scope, item) {
  const media = scope.querySelector('img,video'); if (!media) return;
  const adopt = () => { const w = media.naturalWidth || media.videoWidth, h = media.naturalHeight || media.videoHeight; if (!w || !h) return; const ratio = w / h; if (Math.abs(ratio - item.ratio) < .01) return; item.ratio = ratio; const body = root?.querySelector(`[data-node="${item.id}"] .cv-node-body`); if (body) body.style.aspectRatio = ratio; drawEdges(); drawGroups(); drawSelBox(); placePanel(); save(); };
  if (media.complete || media.readyState >= 1) adopt(); media.addEventListener(media.tagName === 'IMG' ? 'load' : 'loadedmetadata', adopt, { once: true });
}

// ---- 选中的生成节点：下方的输入框 ----
function bind() {
  const only = sel.size === 1 ? node([...sel][0]) : null, target = only?.source === 'gen' ? only : null, panel = $('.cv-panel');
  if (!target) { bound = null; panel.hidden = true; panel.innerHTML = ''; return; }
  const same = bound === target; bound = target;
  Object.assign(draft, { kind: target.type, prompt: target.prompt, refs: sources(target).map(item => ({ id: item.refId, url: item.url || BLANK, nodeId: item.id })), ...target.settings });
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
    const source = sources(bound)[index]; if (!source) return;
    cv.edges = cv.edges.filter(edge => !(edge.from === source.id && edge.to === bound.id));
    dropRef(index); bound.prompt = draft.prompt; paint({ editor: true }); drawEdges(); save();
  },
  async addFiles(files) {
    const target = bound, start = target ? { x: target.x - 380, y: target.y } : toWorld(last.x || innerWidth / 2, last.y || innerHeight / 2);
    for (const [index, file] of files.entries()) {
      if (file.size > 15 * 1024 * 1024) { ctx.notify('请使用 15MB 以内的图片', true); continue; }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        const reference = await ctx.api('/api/studio/references', { method: 'POST', body: { base64: btoa(binary), name: file.name } });
        const created = addNode({ type: 'image', source: 'upload', refId: reference.id, url: reference.url, x: start.x, y: start.y + index * 250 + (target ? sources(target).length * 250 : 0), ratio: 16 / 9 });
        if (target) cv.edges.push({ from: created.id, to: target.id });
      } catch (error) { ctx.notify(error.message, true); }
    }
    drawEdges(); if (target && bound === target) bind(); save();
  },
  async generate() {
    const target = bound; if (!target) throw new Error('请先选中一个生成节点');
    if (activeJob(itemOf(target)?.job)) throw new Error('这个节点还在生成，等它完成再重新生成');
    const refIds = [];
    for (const [index, source] of sources(target).entries()) {
      if (!source.refId) {
        const job = itemOf(source);
        if (!(source.source === 'gen' && job?.kind === 'image' && job.result)) throw new Error(`图${index + 1} 还没有生成好，先等它完成或换一张图`);
        const reference = await ctx.api(`/api/studio/items/${job.id}/reference`, { method: 'POST' }); source.refId = reference.id;
      }
      refIds.push(source.refId);
    }
    const view = await ctx.api('/api/studio/items', { method: 'POST', body: { kind: target.type, prompt: target.prompt, refIds, channel: draft.channel, duration: draft.duration, resolution: draft.resolution, aspectRatio: draft.aspectRatio } });
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
  for (const id of sel) root.querySelector(`[data-node="${id}"]`)?.remove();
  cv.groups = cv.groups.map(group => ({ ...group, nodes: group.nodes.filter(id => !sel.has(id)) })).filter(group => group.nodes.length);
  sel.clear(); drawGroups(); paintSelection(); toggleEmpty(); save();
}
function createFromMenu(kind) {
  const state = menuState; closeMenu(); menuState = null; if (!state) return;
  const point = toWorld(state.clientX, state.clientY), ratio = 16 / 9, w = 320;
  const created = addNode({ type: kind, x: point.x, y: point.y - LABEL - w / ratio / 2 });
  for (const id of state.from || []) cv.edges.push({ from: id, to: created.id });
  sel.clear(); sel.add(created.id); paintSelection(); reveal(created); save();
  requestAnimationFrame(() => document.querySelector('#studio-prompt')?.focus({ preventScroll: true }));
}
const filePicker = document.createElement('input'); filePicker.type = 'file'; filePicker.accept = 'image/png,image/jpeg,image/webp'; filePicker.multiple = true; filePicker.hidden = true; document.body.append(filePicker);
filePicker.addEventListener('change', () => { const files = [...filePicker.files]; filePicker.value = ''; if (cv && files.length) host.addFiles(files); });
const picker = () => filePicker.click();
function openMenu(clientX, clientY, from = null) {
  const { icon } = ctx, menu = $('.cv-menu'); menuState = { clientX, clientY, from };
  menu.innerHTML = `<small>${from ? '用它生成' : '添加节点'}</small><button data-action="canvas-add" data-kind="image">${icon('image', 15)}图片</button><button data-action="canvas-add" data-kind="video">${icon('play', 15)}视频</button>${from ? '' : `<button data-action="canvas-add" data-kind="upload">${icon('upload', 15)}上传图片</button>`}`;
  menu.hidden = false; menu.style.left = `${Math.min(clientX, innerWidth - 190)}px`; menu.style.top = `${Math.min(clientY - 16, innerHeight - 170)}px`;
  if (!calm()) menu.animate([{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
function closeMenu() { const menu = $('.cv-menu'); if (menu && !menu.hidden) { menu.hidden = true; menuState = null; drawEdges(); } }

// ---- 鼠标：拖动画面、框选、移动节点、拉线 ----
function onDown(event) {
  last.x = event.clientX; last.y = event.clientY;
  if (event.target.closest('.cv-panel,.cv-top,.cv-zoom,.cv-dock,.cv-menu,.cv-empty button,.cv-seltools')) return;
  closeMenu();
  const groupElement = event.target.closest('.cv-group'), group = groupElement && cv.groups.find(entry => entry.id === groupElement.dataset.group);
  if (group && event.button === 0 && !space) { if (!event.shiftKey) sel.clear(); for (const member of group.nodes) sel.add(member); paintSelection(); }
  const element = event.target.closest('.cv-node') || (group && root.querySelector(`[data-node="${group.nodes[0]}"]`)), id = element?.dataset.node;
  if (event.button === 1 || (event.button === 0 && space)) { event.preventDefault(); drag = { kind: 'pan', x: event.clientX, y: event.clientY, vx: cv.view.x, vy: cv.view.y }; root.classList.add('grabbing'); }
  else if (event.button !== 0) return;
  else if (event.target.closest('[data-handle-multi]')) { drag = { kind: 'link', multi: true, from: [...sel].filter(other => node(other)?.type === 'image'), x: event.clientX, y: event.clientY, moved: false }; root.classList.add('linking'); }
  else if (event.target.closest('[data-handle]')) { const from = sel.has(id) ? [...sel].filter(other => node(other)?.type === 'image') : [id]; drag = { kind: 'link', from, x: event.clientX, y: event.clientY, moved: false }; root.classList.add('linking'); }
  else if (element) {
    if (event.target.tagName === 'VIDEO' && sel.has(id) && sel.size === 1) return;
    const was = sel.has(id) || Boolean(group);
    if (!sel.has(id)) { if (!event.shiftKey) sel.clear(); sel.add(id); paintSelection(); }
    drag = { kind: 'move', id, was, group: Boolean(group), shift: event.shiftKey, x: event.clientX, y: event.clientY, moved: false, start: [...sel].map(other => { const item = node(other); return { item, x: item.x, y: item.y, element: root.querySelector(`[data-node="${other}"]`) }; }) };
  } else { drag = { kind: 'marquee', x: event.clientX, y: event.clientY, moved: false, base: event.shiftKey ? new Set(sel) : new Set() }; document.activeElement?.blur?.(); }
  if (drag) { root.setPointerCapture(event.pointerId); if (drag.kind !== 'move' || event.target.tagName !== 'VIDEO') event.preventDefault(); }
}
function onMove(event) {
  last.x = event.clientX; last.y = event.clientY; if (!drag) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) > 3) drag.moved = true;
  if (drag.kind === 'pan') { cv.view.x = drag.vx + dx; cv.view.y = drag.vy + dy; applyView(); return; }
  if (!drag.moved) return;
  if (drag.kind === 'move') {
    for (const entry of drag.start) { entry.item.x = entry.x + dx / cv.view.k; entry.item.y = entry.y + dy / cv.view.k; entry.element.style.left = `${entry.item.x}px`; entry.element.style.top = `${entry.item.y}px`; }
    root.classList.add('moving'); drawEdges(); drawGroups(); drawSelBox(); placePanel();
  } else if (drag.kind === 'marquee') {
    const box = $('.cv-marquee'), left = Math.min(drag.x, event.clientX), top = Math.min(drag.y, event.clientY), width = Math.abs(dx), tall = Math.abs(dy);
    box.hidden = false; box.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${tall}px`;
    const a = toWorld(left, top), b = toWorld(left + width, top + tall); sel.clear(); for (const id of drag.base) sel.add(id);
    for (const item of cv.nodes) if (item.x < b.x && item.x + item.w > a.x && item.y < b.y && item.y + LABEL + height(item) > a.y) sel.add(item.id);
    for (const element of root.querySelectorAll('.cv-node')) element.classList.toggle('selected', sel.has(element.dataset.node));
    drawSelBox();
  } else if (drag.kind === 'link') {
    const to = toWorld(event.clientX, event.clientY), over = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.cv-node');
    for (const element of root.querySelectorAll('.cv-node.target')) element.classList.remove('target');
    const target = over && node(over.dataset.node); if (target?.source === 'gen' && !drag.from.includes(target.id)) over.classList.add('target');
    drawEdges(tempEdges(drag.from, to));
  }
}
function onUp(event) {
  const current = drag; drag = null; if (!current) return;
  root.classList.remove('grabbing', 'moving', 'linking');
  if (current.kind === 'pan') return save();
  if (current.kind === 'move') {
    if (current.moved) return save();
    if (current.group) return paintSelection();
    if (current.shift && current.was) sel.delete(current.id); else if (!current.shift && sel.size > 1) { sel.clear(); sel.add(current.id); }
    return paintSelection();
  }
  if (current.kind === 'marquee') { $('.cv-marquee').hidden = true; if (!current.moved) { sel.clear(); for (const id of current.base) sel.add(id); } return paintSelection(); }
  if (current.kind === 'link') {
    for (const element of root.querySelectorAll('.cv-node.target')) element.classList.remove('target');
    const over = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.cv-node'), target = over && node(over.dataset.node);
    if (target?.source === 'gen' && !current.from.includes(target.id)) {
      for (const id of current.from) if (!cv.edges.some(edge => edge.from === id && edge.to === target.id)) cv.edges.push({ from: id, to: target.id });
      sel.clear(); sel.add(target.id); paintSelection(); return save();
    }
    if (over && current.moved) return drawEdges();
    // 松手在空白处：线先留着，弹出菜单选要生成什么。
    const point = current.moved ? { x: event.clientX, y: event.clientY } : (() => { const area = current.multi && boundsOf(current.from), out = area ? { x: area.r + 18, y: (area.t + area.b) / 2 } : anchorOut(node(current.from[0])); return { x: cv.view.x + (out.x + 90) * cv.view.k, y: cv.view.y + out.y * cv.view.k }; })();
    openMenu(point.x, point.y, current.from);
    drawEdges(tempEdges(current.from, toWorld(point.x, point.y)));
  }
}
function onWheel(event) {
  if (event.target.closest('.cv-panel,.cv-menu')) return;
  event.preventDefault();
  const mouse = event.deltaMode !== 0 || (event.deltaX === 0 && Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= 50);
  if (event.ctrlKey || event.metaKey || mouse) zoomAt(cv.view.k * Math.exp(-event.deltaY * (event.ctrlKey && !mouse ? .01 : .0015) * (event.deltaMode === 1 ? 16 : 1)), event.clientX, event.clientY);
  else { cv.view.x -= event.deltaX; cv.view.y -= event.deltaY; applyView(); save(); }
}
const typing = target => target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '');
document.addEventListener('keydown', event => {
  if (!cv || ctx.state.modal || document.querySelector('.image-lightbox')) return;
  if (event.key === 'Escape' && !typing(event.target)) { if (menuState) return closeMenu(); sel.clear(); return paintSelection(); }
  if (typing(event.target)) return;
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
  root.innerHTML = `<div class="cv-world"><div class="cv-groups"></div><svg class="cv-edges" aria-hidden="true"></svg><div class="cv-nodes"></div><div class="cv-selbox" hidden></div></div><div class="cv-marquee" hidden></div>
<div class="cv-top"><button class="cv-back" data-action="canvas-close" title="返回">${icon('arrow', 15)}</button><input class="cv-title" value="${escape(cv.title)}" maxlength="60" aria-label="画布名称" spellcheck="false"></div>
<div class="cv-empty"><p>双击画布添加节点</p><div><button data-action="canvas-add" data-kind="image">${icon('image', 15)}图片生成</button><button data-action="canvas-add" data-kind="video">${icon('play', 15)}视频生成</button><button data-action="canvas-add" data-kind="upload">${icon('upload', 15)}上传图片</button></div></div>
<div class="cv-panel studio-composer" hidden></div><div class="cv-menu" hidden></div>
<div class="cv-zoom"><button data-action="canvas-zoom" data-dir="out" aria-label="缩小">−</button><output>100%</output><button data-action="canvas-zoom" data-dir="in" aria-label="放大">＋</button><button data-action="canvas-zoom" data-dir="fit" title="看全部节点">适应</button></div>
<div class="cv-dock"><button data-action="canvas-add" data-kind="image" title="添加图片生成节点">${icon('image', 16)}</button><button data-action="canvas-add" data-kind="video" title="添加视频生成节点">${icon('play', 16)}</button><button data-action="canvas-add" data-kind="upload" title="上传图片">${icon('upload', 16)}</button><i></i><span>空格 拖动画面 · 滚轮 缩放 · 拖动 框选 · Delete 删除</span></div>`;
  document.body.append(root); document.documentElement.classList.add('cv-open');
  root.addEventListener('pointerdown', onDown); root.addEventListener('pointermove', onMove); root.addEventListener('pointerup', onUp); root.addEventListener('pointercancel', onUp);
  root.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('dblclick', event => {
    const under = document.elementFromPoint(event.clientX, event.clientY), element = under?.closest('.cv-node');
    if (under?.closest('.cv-panel,.cv-top,.cv-zoom,.cv-dock,.cv-menu,.cv-empty button,.cv-seltools')) return;
    const label = under?.closest('.cv-group-label'), named = label && cv.groups.find(entry => entry.id === label.parentElement.dataset.group);
    if (named) { const next = prompt('分组名称', named.label); if (next !== null) { named.label = next.trim().slice(0, 40) || named.label; drawGroups(); save(); } return; }
    if (under?.closest('.cv-group') && !under.closest('.cv-node')) return;
    if (element) { const image = element.querySelector('.cv-node-body img'); if (image && image.getAttribute('src') !== BLANK) ctx.openImage(image); return; }
    openMenu(event.clientX, event.clientY);
  });
  root.querySelector('.cv-title').addEventListener('input', event => { cv.title = event.target.value; save(); });
  setHost(host); drawNodes(); for (const item of cv.nodes) watchMedia(root.querySelector(`[data-node="${item.id}"]`), item); applyView();
  if (!calm()) root.animate([{ opacity: 0, transform: 'scale(1.015)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
async function close() {
  if (!cv) return; const leaving = root; await save(false);
  cv = null; root = null; bound = null; sel.clear(); release(); setHost(null); document.documentElement.classList.remove('cv-open');
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
  if (action === 'canvas-zoom') { const dir = button.dataset.dir; return dir === 'fit' ? fit() : zoomAt(cv.view.k * (dir === 'in' ? 1.25 : .8), innerWidth / 2, innerHeight / 2, true); }
  if (action === 'canvas-add') {
    if (!menuState) { const rect = button.closest('.cv-dock,.cv-empty') ? { x: innerWidth / 2 + (cv.nodes.length % 6) * 26 - 160, y: innerHeight / 2 + (cv.nodes.length % 6) * 26 - 60 } : { x: last.x, y: last.y }; menuState = { clientX: rect.x, clientY: rect.y, from: null }; }
    if (button.dataset.kind === 'upload') { const state = menuState; closeMenu(); menuState = null; last.x = state.clientX; last.y = state.clientY; sel.clear(); paintSelection(); return picker(); }
    return createFromMenu(button.dataset.kind);
  }
}
