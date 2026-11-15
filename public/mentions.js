const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
// The list follows the caret query; clicking a thumbnail elsewhere only opens preview.
export function attachMentions(input, assets) {
  const menu = document.createElement('div'); menu.className = 'mention-menu'; menu.hidden = true;
  menu.id = 'asset-mention-menu'; menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', '选择引用素材');
  document.body.append(menu); input.setAttribute('aria-controls', menu.id); input.setAttribute('aria-autocomplete', 'list');
  let matches = [], selected = 0, queryStart = -1;
  function hide() { menu.hidden = true; input.setAttribute('aria-expanded','false'); input.removeAttribute('aria-activedescendant'); }
  function draw() {
    menu.innerHTML = matches.length ? matches.map((asset,index) => `<button type="button" role="option" id="mention-${index}" data-mention-index="${index}" aria-selected="${index===selected}" class="${index===selected?'active':''}"><img src="${escape(asset.image.url)}" alt=""><span>${escape(asset.name)}</span><small>${{character:'人物',scene:'场景',prop:'道具',frame:'分镜图'}[asset.kind]||'素材'}</small></button>`).join('') : '<p>没有匹配的素材，继续输入名称或按 Esc 返回</p>';
    menu.hidden = false; input.setAttribute('aria-expanded','true');
    const rect=input.getBoundingClientRect(),width=Math.min(460,rect.width,innerWidth-24);
    menu.style.width=`${width}px`;menu.style.left=`${Math.max(12,Math.min(rect.left,innerWidth-width-12))}px`;
    const height=Math.min(menu.scrollHeight,270);
    menu.style.top=`${Math.max(12,Math.min(rect.bottom+5,innerHeight-height-16))}px`;

    if (matches.length) input.setAttribute('aria-activedescendant',`mention-${selected}`);
  }
  function update() {
    const caret = input.selectionStart, text = input.value;
    if (caret !== input.selectionEnd) return hide();
    const at = text.lastIndexOf('@',caret-1);
    if (at < 0) return hide();
    const query = text.slice(at+1,caret);
    if (query.length>60 || /[\n@，。！？；：,!?;:]/.test(query) || /\s$/.test(query)) return hide();
    queryStart = at; matches = assets.filter(asset=>asset.name.toLowerCase().includes(query.toLowerCase())); selected = 0; draw();
  }
  function choose(index) {
    const asset = matches[index]; if (!asset || queryStart < 0) return;
    input.setRangeText(`@${asset.name} `, queryStart, input.selectionStart, 'end');
    hide(); input.focus({preventScroll:true}); input.dispatchEvent(new Event('input',{bubbles:true}));
  }
  input.addEventListener('input',update);input.addEventListener('click',update);
  input.addEventListener('keydown',event=>{
    if (menu.hidden || event.isComposing) return;
    if (event.key==='Escape') { event.preventDefault();event.stopImmediatePropagation();hide(); }
    if (['ArrowDown','ArrowUp'].includes(event.key)&&matches.length) {
      event.preventDefault();event.stopPropagation(); selected=(selected+(event.key==='ArrowDown'?1:-1)+matches.length)%matches.length;draw();menu.querySelector('.active')?.scrollIntoView({block:'nearest'});
    }
    if (event.key==='Enter' && matches.length) {event.preventDefault();event.stopPropagation();choose(selected);}
  });
  menu.addEventListener('pointerdown',event=>event.preventDefault());
  menu.addEventListener('click',event=>{const button=event.target.closest('[data-mention-index]');if(button)choose(Number(button.dataset.mentionIndex));});
  const observer=new MutationObserver(()=>{if(!input.isConnected){menu.remove();observer.disconnect();}});observer.observe(document.querySelector('#modal-root'),{childList:true,subtree:true});
  input.addEventListener('blur',()=>setTimeout(()=>{if(document.activeElement!==input)hide();},100));
}
