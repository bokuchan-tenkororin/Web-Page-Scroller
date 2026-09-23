(() => {
  if (window.__WEB_PAGE_SCROLLER_INJECTED__) return;
  window.__WEB_PAGE_SCROLLER_INJECTED__ = true;

  const DEFAULT_SETTINGS = {
    globalScrollPercent: 100,
    siteRules: [],
    autoScroll: { speed: 1 },
    bookmark: { folderId: null, folderTitle: "" }
  };

  let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  let autoScrolling = false;
  let rafId = null;
  let indicatorEl = null;
  let dialogOverlay = null;

  function clone(o){ return JSON.parse(JSON.stringify(o)); }

  async function loadSettings(){
    try{
      const r = await chrome.storage.sync.get(["settings"]);
      if(r.settings){
        settings = {
          ...clone(DEFAULT_SETTINGS),
          ...r.settings,
          autoScroll: { ...clone(DEFAULT_SETTINGS).autoScroll, ...(r.settings.autoScroll||{}) },
          bookmark: { ...clone(DEFAULT_SETTINGS).bookmark, ...(r.settings.bookmark||{}) },
          siteRules: Array.isArray(r.settings.siteRules) ? r.settings.siteRules : []
        };
      }
    }catch(e){ console.warn("[Web Page Scroller] load fail", e); }
  }

  function matchPattern(url, pattern){
    if(!pattern) return false;
    const p=pattern.trim(); if(!p) return false;
    if(p.includes("*")){
      try{
        const esc=p.replace(/[.+?^${}()|[\]\\]/g,"\\$&").replace(/\*/g,".*");
        return new RegExp(esc,"i").test(url);
      }catch{ return url.toLowerCase().includes(p.replace(/\*/g,"").toLowerCase()); }
    }
    return url.toLowerCase().includes(p.toLowerCase());
  }
  function getScrollPercent(){
    const url=location.href;
    let best=null, bestLen=-1;
    for(const r of settings.siteRules||[]){
      if(r.enabled===false) continue;
      if(matchPattern(url, r.pattern)){
        const len=(r.pattern||"").length;
        if(len>bestLen){ best=r; bestLen=len; }
      }
    }
    if(best) return Number(best.scrollPercent);
    return Number(settings.globalScrollPercent);
  }
  function isEditable(el){
    if(!el) return false;
    try{
      const tag=el.tagName?.toLowerCase();
      if(tag==="input"||tag==="textarea"||tag==="select") return true;
      if(el.isContentEditable) return true;
      if(el.closest && el.closest('[contenteditable="true"],[contenteditable=""],[contenteditable]')) return true;
    }catch{}
    return false;
  }
  function isEditableTarget(t){
    if(isEditable(t)) return true;
    const ae=document.activeElement;
    return ae && isEditable(ae);
  }
  function isSpace(e){ return e.code==="Space" || e.key===" " || e.key==="Spacebar" || e.keyCode===32; }
  function getAmount(){
    const p=getScrollPercent();
    if(p===0) return 0;
    return window.innerHeight * p / 100;
  }
  function getMainScrollable(){
    const se = document.scrollingElement || document.documentElement;
    if(se && se.scrollHeight > se.clientHeight + 20) return se;
    let best=null, bestH=0;
    for(const el of document.querySelectorAll('main, div, section, article')){
      try{
        const s=window.getComputedStyle(el);
        if((s.overflowY==='auto'||s.overflowY==='scroll') && el.scrollHeight > el.clientHeight+20 && el.scrollHeight > bestH){
          bestH=el.scrollHeight; best=el;
        }
      }catch{}
    }
    return best || se || document.documentElement;
  }
  function doScrollBy(delta){
    if(delta===0) return;
    const main = getMainScrollable();
    try{
      if(main === document.scrollingElement || main === document.documentElement || main === document.body){
        window.scrollBy(0, delta);
      }else{
        main.scrollTop += delta;
      }
    }catch{}
  }
  function makeIndicator(){
    if(indicatorEl) return;
    const d=document.createElement("div");
    d.id="__web_page_scroller_indicator__";
    d.textContent="● Auto scrolling (Ctrl+Shift+Z to stop)";
    try{
      const msg=chrome.i18n.getMessage("autoScrolling");
      if(msg) d.textContent=msg;
    }catch{}
    Object.assign(d.style,{
      position:"fixed",right:"16px",bottom:"16px",
      background:"rgba(0,0,0,0.88)",color:"#fff",
      padding:"9px 14px",borderRadius:"20px",fontSize:"12px",
      zIndex:"2147483647",fontFamily:"sans-serif",pointerEvents:"none",
      boxShadow:"0 2px 12px rgba(0,0,0,0.35)"
    });
    (document.body||document.documentElement).appendChild(d);
    indicatorEl=d;
  }
  function removeIndicator(){
    if(indicatorEl && indicatorEl.parentNode){ try{indicatorEl.parentNode.removeChild(indicatorEl);}catch{} }
    indicatorEl=null;
  }
  function startAuto(){
    if(autoScrolling) return;
    autoScrolling=true;
    makeIndicator();
    const speed = Math.max(0.1, Number(settings?.autoScroll?.speed)||1);
    function step(){
      if(!autoScrolling) return;
      doScrollBy(speed);
      rafId=requestAnimationFrame(step);
    }
    rafId=requestAnimationFrame(step);
    window.__WEB_PAGE_SCROLLER_STATE__={autoScrolling:true};
  }
  function stopAuto(){
    if(!autoScrolling) return;
    autoScrolling=false;
    if(rafId){ cancelAnimationFrame(rafId); rafId=null; }
    removeIndicator();
    window.__WEB_PAGE_SCROLLER_STATE__={autoScrolling:false};
  }
  function toggleAuto(){
    if(autoScrolling) stopAuto(); else startAuto();
  }
  function onKeyDown(e){
    // ダイアログが開いている時はスペース無効化しないようにエスケープ
    if(dialogOverlay) {
      if(e.key==="Escape"){ closeRegisterDialog(); }
      return;
    }
    if(isEditableTarget(e.target)) return;
    if(!isSpace(e)) return;
    if(e.ctrlKey||e.altKey||e.metaKey) return;
    e.preventDefault(); e.stopPropagation();
    if(e.stopImmediatePropagation) e.stopImmediatePropagation();
    if(autoScrolling) stopAuto();
    const amt=getAmount();
    if(amt===0) return;
    const delta = e.shiftKey ? -amt : amt;
    doScrollBy(delta);
  }
  function onKeyUp(e){ if(e.key==="Escape" && autoScrolling) stopAuto(); }

  // ========== 登録ダイアログ ==========
  function isStandardPercent(v){ return [100,90,80,70,60,50,40,30,20,10,0].includes(Number(v)); }

  function injectDialogStyles(){
    if(document.getElementById("__wps_dialog_styles__")) return;
    const style=document.createElement("style");
    style.id="__wps_dialog_styles__";
    style.textContent=`
      #__web_page_scroller_dialog_overlay__{
        position:fixed; inset:0; background:rgba(0,0,0,0.45); backdrop-filter:blur(2px);
        z-index:2147483646; display:flex; align-items:center; justify-content:center;
        font-family:"Segoe UI", Meiryo, sans-serif;
      }
      #__web_page_scroller_dialog_overlay__ .wps-dialog{
        background:#fff; border-radius:16px; padding:22px 22px 18px; width:420px; max-width:90vw;
        box-shadow:0 20px 60px rgba(0,0,0,0.32); color:#222; line-height:1.5;
        animation:wps-pop 0.18s ease-out;
      }
      @keyframes wps-pop{ from{ transform:scale(0.96) translateY(6px); opacity:0; } to{ transform:scale(1) translateY(0); opacity:1; } }
      #__web_page_scroller_dialog_overlay__ .wps-dialog h2{
        margin:0 0 14px; font-size:16px; border-left:4px solid #4f7cff; padding-left:8px;
      }
      #__web_page_scroller_dialog_overlay__ .wps-row{ display:flex; align-items:center; gap:10px; margin:10px 0; flex-wrap:wrap; }
      #__web_page_scroller_dialog_overlay__ .wps-row label{ min-width:110px; font-weight:600; font-size:13px; }
      #__web_page_scroller_dialog_overlay__ .wps-row input[type="text"],
      #__web_page_scroller_dialog_overlay__ .wps-row select,
      #__web_page_scroller_dialog_overlay__ .wps-row input[type="number"]{
        flex:1; padding:8px 10px; border:1px solid #d0d7e2; border-radius:8px; font-size:14px; min-width:160px;
      }
      #__web_page_scroller_dialog_overlay__ .wps-hint{ color:#6b7280; font-size:11px; margin:4px 0 2px 110px; }
      #__web_page_scroller_dialog_overlay__ .wps-status{ min-height:18px; font-size:12px; margin:8px 0; }
      #__web_page_scroller_dialog_overlay__ .wps-status.ok{ color:#0a7a42; }
      #__web_page_scroller_dialog_overlay__ .wps-status.err{ color:#c53030; }
      #__web_page_scroller_dialog_overlay__ .wps-actions{ display:flex; gap:8px; justify-content:flex-end; margin-top:16px; flex-wrap:wrap; }
      #__web_page_scroller_dialog_overlay__ .wps-btn{ padding:8px 14px; border-radius:8px; border:1px solid #d0d7e2; background:#fff; cursor:pointer; font-size:13px; }
      #__web_page_scroller_dialog_overlay__ .wps-btn.primary{ background:#4f7cff; color:#fff; border-color:#4f7cff; }
      #__web_page_scroller_dialog_overlay__ .wps-btn.danger{ color:#e53e3e; border-color:#fbd5d5; background:#fff5f5; }
      #__web_page_scroller_dialog_overlay__ .wps-btn:hover{ filter:brightness(0.97); }
      #__web_page_scroller_dialog_overlay__ .wps-current{ background:#f8fafc; border:1px solid #e6eaf0; border-radius:8px; padding:8px 10px; font-size:12px; margin:10px 0; }
    `;
    (document.head||document.documentElement).appendChild(style);
  }

  function closeRegisterDialog(){
    if(dialogOverlay && dialogOverlay.parentNode){
      try{ dialogOverlay.parentNode.removeChild(dialogOverlay); }catch{}
    }
    dialogOverlay=null;
    const s=document.getElementById("__wps_dialog_styles__");
    // スタイルは残してもOKだが、閉じるたびに消すならコメントアウト
  }

  function showRegisterDialog(){
    injectDialogStyles();
    if(dialogOverlay){
      closeRegisterDialog();
      return;
    }
    const url=location.href;
    const host=location.hostname;
    // 最長一致の既存ルールを探す
    let best=null, bestLen=-1;
    for(const r of settings.siteRules||[]){
      if(matchPattern(url, r.pattern)){
        const len=(r.pattern||"").length;
        if(len>bestLen){ best=r; bestLen=len; }
      }
    }
    // ホスト名完全一致も探す
    if(!best){
      best = (settings.siteRules||[]).find(r=>r.pattern===host) || null;
    }

    const initialPattern = best ? best.pattern : host;
    const initialPercent = best ? best.scrollPercent : getScrollPercent();
    const initialEnabled = best ? (best.enabled!==false) : true;
    const globalPercent = settings.globalScrollPercent;

    const overlay=document.createElement("div");
    overlay.id="__web_page_scroller_dialog_overlay__";
    overlay.addEventListener("click", (e)=>{ if(e.target===overlay) closeRegisterDialog(); });

    const isStd = isStandardPercent(initialPercent);

    overlay.innerHTML=`
      <div class="wps-dialog" role="dialog" aria-modal="true">
        <h2>Web Page Scroller - ページ登録</h2>
        <div class="wps-current">
          現在: <b>${host}</b><br>
          適用中: <b>${getScrollPercent()}%</b> (グローバル ${globalPercent}%)<br>
          URL: <span style="word-break:break-all; color:#6b7280;">${url.slice(0,120)}</span>
        </div>
        <div class="wps-row">
          <label>パターン</label>
          <input type="text" id="wps-pattern" value="${initialPattern.replace(/"/g,'&quot;')}" placeholder="例: youtube.com または *example.com*">
        </div>
        <div class="wps-hint">ワイルドカード * 対応。部分一致で判定、最長一致が優先されます。</div>
        <div class="wps-row">
          <label>スクロール量</label>
          <select id="wps-percent-select"></select>
          <div id="wps-custom-wrap" style="display:${isStd?'none':'flex'}; align-items:center; gap:6px;">
            <input type="number" id="wps-custom-input" min="0" max="500" step="1" value="${Number(initialPercent)}" style="width:90px; min-width:90px;">
            <span>%</span>
          </div>
        </div>
        <div class="wps-row">
          <label>有効</label>
          <input type="checkbox" id="wps-enabled" ${initialEnabled?'checked':''}>
          <span style="font-size:12px;">このルールを有効にする</span>
        </div>
        <div id="wps-status" class="wps-status"></div>
        <div class="wps-actions">
          <button class="wps-btn" id="wps-cancel">キャンセル</button>
          ${best ? '<button class="wps-btn danger" id="wps-delete">削除</button>' : ''}
          <button class="wps-btn" id="wps-options">詳細設定</button>
          <button class="wps-btn primary" id="wps-save">保存</button>
        </div>
      </div>
    `;

    (document.body||document.documentElement).appendChild(overlay);
    dialogOverlay=overlay;

    const sel=overlay.querySelector("#wps-percent-select");
    for(let i=100;i>=0;i-=10){
      const o=document.createElement("option");
      o.value=String(i); o.textContent=i+"%";
      sel.appendChild(o);
    }
    const co=document.createElement("option");
    co.value="custom"; co.textContent="カスタム...";
    sel.appendChild(co);
    if(isStd) sel.value=String(Number(initialPercent));
    else sel.value="custom";

    const customWrap=overlay.querySelector("#wps-custom-wrap");
    sel.addEventListener("change", ()=>{
      if(sel.value==="custom") customWrap.style.display="flex";
      else customWrap.style.display="none";
    });

    const statusEl=overlay.querySelector("#wps-status");
    function setStatus(msg, ok){
      statusEl.textContent=msg;
      statusEl.className="wps-status "+(ok?"ok":"err");
    }

    overlay.querySelector("#wps-cancel").addEventListener("click", closeRegisterDialog);
    overlay.querySelector("#wps-options").addEventListener("click", ()=>{
      try{ chrome.runtime.sendMessage({type:"OPEN_OPTIONS"}); }catch{}
      // フォールバック: 直接URLを開く
      try{
        const url=chrome.runtime.getURL("options.html");
        window.open(url, "_blank");
      }catch{}
    });

    const deleteBtn=overlay.querySelector("#wps-delete");
    if(deleteBtn){
      deleteBtn.addEventListener("click", async ()=>{
        const pattern=overlay.querySelector("#wps-pattern").value.trim();
        if(!pattern){ setStatus("パターンを入力してください", false); return; }
        try{
          const res=await chrome.storage.sync.get(["settings"]);
          let s=res.settings || clone(DEFAULT_SETTINGS);
          s.siteRules=(s.siteRules||[]).filter(r=>r.pattern!==pattern);
          await chrome.storage.sync.set({settings:s});
          if(s.bookmark?.folderId){
            try{ chrome.runtime.sendMessage({type:"SAVE_TO_BOOKMARK", settings:s, folderId:s.bookmark.folderId}); }catch{}
          }
          setStatus("削除しました ✔", true);
          setTimeout(closeRegisterDialog, 800);
        }catch(e){ setStatus("削除失敗: "+e.message, false); }
      });
    }

    overlay.querySelector("#wps-save").addEventListener("click", async ()=>{
      const patternInput=overlay.querySelector("#wps-pattern");
      const pattern=patternInput.value.trim();
      if(!pattern){ setStatus("パターンを入力してください", false); patternInput.focus(); return; }
      let percent;
      if(sel.value==="custom"){
        percent=Number(overlay.querySelector("#wps-custom-input").value);
        if(isNaN(percent)){ setStatus("数値を入力してください", false); return; }
      } else {
        percent=Number(sel.value);
      }
      if(percent<0 || percent>500){ setStatus("0〜500%で入力してください", false); return; }
      const enabled=overlay.querySelector("#wps-enabled").checked;

      try{
        const res=await chrome.storage.sync.get(["settings"]);
        let s=res.settings || clone(DEFAULT_SETTINGS);
        s.siteRules=s.siteRules||[];
        const idx=s.siteRules.findIndex(r=>r.pattern===pattern);
        if(idx>=0){
          s.siteRules[idx]={pattern, scrollPercent:percent, enabled};
        } else {
          s.siteRules.push({pattern, scrollPercent:percent, enabled});
        }
        await chrome.storage.sync.set({settings:s});
        if(s.bookmark?.folderId){
          try{ chrome.runtime.sendMessage({type:"SAVE_TO_BOOKMARK", settings:s, folderId:s.bookmark.folderId}); }catch{}
        }
        setStatus(`保存しました ✔ ${pattern} → ${percent}%`, true);
        setTimeout(closeRegisterDialog, 900);
      }catch(e){
        setStatus("保存失敗: "+e.message, false);
      }
    });

    // パターン入力にフォーカス
    setTimeout(()=>{ const inp=overlay.querySelector("#wps-pattern"); if(inp) inp.focus(); }, 50);
  }

  window.__WEB_PAGE_SCROLLER_TOGGLE__ = toggleAuto;
  window.__WEB_PAGE_SCROLLER_STOP__ = stopAuto;
  window.__WEB_PAGE_SCROLLER_SHOW_DIALOG__ = showRegisterDialog;
  window.__WEB_PAGE_SCROLLER_STATE__ = { autoScrolling:false };

  loadSettings().then(()=>{
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
  });

  chrome.storage.onChanged.addListener((changes, area)=>{
    if(area==="sync" && changes.settings){
      const nv=changes.settings.newValue;
      if(nv){
        settings={...clone(DEFAULT_SETTINGS),...nv, autoScroll:{...clone(DEFAULT_SETTINGS).autoScroll,...(nv.autoScroll||{})}, bookmark:{...clone(DEFAULT_SETTINGS).bookmark,...(nv.bookmark||{})}, siteRules:Array.isArray(nv.siteRules)?nv.siteRules:[]};
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg)=>{
    if(msg.type==="TOGGLE_AUTO_SCROLL"){ toggleAuto(); return Promise.resolve({ok:true}); }
    if(msg.type==="SHOW_REGISTER_DIALOG"){ showRegisterDialog(); return Promise.resolve({ok:true}); }
    if(msg.type==="PING"){ return Promise.resolve({ok:true, autoScrolling}); }
  });

  window.addEventListener("web-page-scroller-toggle", ()=>{ toggleAuto(); });
  console.log("[Web Page Scroller] Injected", location.href);
})();
