const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let viewer = null;
export const imageViewerOpen = () => !!viewer;
export function closeImageViewer() { viewer?.close(); }

export function markZoomableImages(root = document) {
  for (const img of root.querySelectorAll('.asset-visual img,.edit-image img,.review-ref img,.shot-preview>img,.ref-chip img,.reference-picker img')) {
    img.dataset.zoomImage = '';
    img.tabIndex = 0; img.setAttribute('role', 'button');
    img.setAttribute('aria-label', `放大查看${img.alt || '参考图'}`);
    img.title = '点击放大查看';
  }
}

export function openImageViewer(source) {
  if (viewer) return;
  const previousFocus = document.activeElement;
  const root = document.createElement('div'); root.className = 'image-lightbox';
  root.innerHTML = `<section class="image-dialog" role="dialog" aria-modal="true" aria-label="图片预览"><header><div><strong>${escape(source.alt || '图片预览')}</strong><span>滚轮缩放 · 拖动查看 · 点击图片外空白关闭</span></div><button type="button" data-viewer="close" aria-label="关闭图片预览">✕</button></header><div class="image-stage"><img src="${escape(source.currentSrc || source.src)}" alt="${escape(source.alt || '参考图')}" draggable="false"></div><footer><button type="button" data-viewer="out" aria-label="缩小图片">−</button><output aria-live="polite">100%</output><button type="button" data-viewer="in" aria-label="放大图片">＋</button><button type="button" data-viewer="reset">适应窗口</button><a href="${escape(source.currentSrc || source.src)}" download>下载原图 ↗</a></footer></section>`;
  document.body.append(root);
  const stage = root.querySelector('.image-stage'), img = stage.querySelector('img'), output = root.querySelector('output');
  let scale = 1, x = 0, y = 0, drag = null, closed = false, didDrag = false;
  const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
  function paint() {
    img.style.transform = `translate3d(${x}px,${y}px,0) scale(${scale})`;
    output.value = `${Math.round(scale * 100)}%`;
    stage.classList.toggle('is-zoomed', scale > 1.001);
  }
  function zoom(next, clientX, clientY) {
    const target = Math.min(8, Math.max(.25, next));
    const bounds = stage.getBoundingClientRect();
    const cx = (clientX ?? bounds.left + bounds.width / 2) - bounds.left - bounds.width / 2;
    const cy = (clientY ?? bounds.top + bounds.height / 2) - bounds.top - bounds.height / 2;
    const ratio = target / scale; x = cx - (cx - x) * ratio; y = cy - (cy - y) * ratio;
    scale = target; paint();
  }
  function reset() { scale = 1; x = y = 0; paint(); }
  const close = () => {
    if (closed) return; closed = true;
    document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', reset);
    viewer = null; document.body.style.overflow = overflow;
    const animation = reduceMotion() ? null : root.animate([{opacity:1},{opacity:0}], {duration:160,easing:'ease-out'});
    const cleanup = () => { root.remove(); if (previousFocus?.isConnected) previousFocus.focus({preventScroll:true}); };
    if (animation) animation.finished.then(cleanup, cleanup); else cleanup();
  };
  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(scale * 1.25); }
    if (event.key === '-') { event.preventDefault(); zoom(scale / 1.25); }
    if (event.key === '0') { event.preventDefault(); reset(); }
    if (event.key === 'Tab') {
      const focusable = [...root.querySelectorAll('button,a')], first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }
  stage.addEventListener('wheel', event => {
    event.preventDefault(); zoom(scale * Math.exp(-event.deltaY * .004 * (event.deltaMode === 1 ? 16 : 1)), event.clientX, event.clientY);
  }, {passive:false});
  stage.addEventListener('pointerdown', event => {
    didDrag = false;
    if (event.button !== 0 || event.target !== img) return;
    drag = {id:event.pointerId, x:event.clientX, y:event.clientY, startX:x, startY:y};
    stage.setPointerCapture(event.pointerId); stage.classList.add('dragging'); event.preventDefault();
  });
  stage.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) didDrag = true;
    x = drag.startX + event.clientX - drag.x; y = drag.startY + event.clientY - drag.y; paint();
  });
  const endDrag = () => { drag = null; stage.classList.remove('dragging'); };
  stage.addEventListener('pointerup', endDrag); stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('dblclick', event => { if(event.target === img) reset(); });
  root.addEventListener('click', event => {
    const action = event.target.closest('[data-viewer]')?.dataset.viewer;
    if (action === 'close' || (!didDrag && [root, stage, root.querySelector('.image-dialog')].includes(event.target))) close();
    else if (action === 'in') zoom(scale * 1.25);
    else if (action === 'out') zoom(scale / 1.25);
    else if (action === 'reset') reset();
  });
  document.addEventListener('keydown', onKey, true); window.addEventListener('resize', reset);
  viewer = { close }; root.querySelector('button').focus({preventScroll:true});
}
