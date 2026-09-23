const DEFAULT = {
  globalScrollPercent: 100,
  scrollMethod: "instant",
  siteRules: [],
  autoScroll: { speed: 1 },
  bookmark: { folderId: null, folderTitle: "" }
};

let saveDebounceTimer = null;
let lastSavedFolderId = null;

function el(id){ return document.getElementById(id); }
function i18n(k,...args){ try{ return args.length?chrome.i18n.getMessage(k,args):chrome.i18n.getMessage(k)||""; }catch{return"";} }
function applyI18n(){ document.querySelectorAll("[data-i18n]").forEach(n=>{ const k=n.getAttribute("data-i18n"); const m=i18n(k); if(m && n.childElementCount===0) n.textContent=m; }); }
function buildPercentOptions(){
  const sel=el("globalSelect"); sel.innerHTML="";
  for(let i=100;i>=0;i-=10){ const o=document.createElement("option"); o.value=String(i); o.textContent=i+"%"; sel.appendChild(o); }
  const c=document.createElement("option"); c.value="custom"; c.textContent=i18n("customOption")||"Custom..."; sel.appendChild(c);
}
function buildRuleSelect(sel,val){
  sel.innerHTML="";
  for(let i=100;i>=0;i-=10){ const o=document.createElement("option"); o.value=String(i); o.textContent=i+"%"; sel.appendChild(o); }
  const c=document.createElement("option"); c.value="custom"; c.textContent=i18n("customOption")||"Custom..."; sel.appendChild(c);
  const num=Number(val);
  if([100,90,80,70,60,50,40,30,20,10,0].includes(num)) sel.value=String(num); else sel.value="custom";
}
function isStandard(v){ return [100,90,80,70,60,50,40,30,20,10,0].includes(Number(v)); }
function esc(s){ return (s||"").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;"); }

function createRuleRow(rule={pattern:"",scrollPercent:100,enabled:true}){
  const div=document.createElement("div"); div.className="rule";
  const en=rule.enabled!==false;
  div.innerHTML=`<input type="checkbox" class="rule-enabled" ${en?"checked":""}><input type="text" class="rule-pattern" placeholder="${i18n("rulePlaceholder")}" value="${esc(rule.pattern||"")}"><select class="rule-select"></select><div class="custom-wrap ${isStandard(rule.scrollPercent)?"hidden":""}"><input type="number" class="rule-custom" min="0" max="500" step="1" value="${Number(rule.scrollPercent)}"><span>%</span></div><button class="btn small delete-btn">${i18n("delete")||"Delete"}</button>`;
  const sel=div.querySelector(".rule-select"); buildRuleSelect(sel,rule.scrollPercent);
  const wrap=div.querySelector(".custom-wrap");
  sel.addEventListener("change",()=>{ if(sel.value==="custom") wrap.classList.remove("hidden"); else wrap.classList.add("hidden"); scheduleAutoSave(); });
  div.querySelector(".rule-pattern").addEventListener("input",scheduleAutoSave);
  div.querySelector(".rule-custom").addEventListener("input",scheduleAutoSave);
  div.querySelector(".rule-enabled").addEventListener("change",scheduleAutoSave);
  div.querySelector(".delete-btn").addEventListener("click",()=>{ div.remove(); scheduleAutoSave(); });
  return div;
}

async function loadSettings(){
  applyI18n();
  const res=await chrome.storage.sync.get(["settings"]);
  const s=res.settings ? {...DEFAULT, ...res.settings, autoScroll:{...DEFAULT.autoScroll, ...(res.settings.autoScroll||{})}, bookmark:{...DEFAULT.bookmark, ...(res.settings.bookmark||{})}} : DEFAULT;
  lastSavedFolderId = s.bookmark.folderId || null;
  buildPercentOptions();
  const gSel=el("globalSelect"), gWrap=el("globalCustomWrap"), gIn=el("globalCustomInput");
  if(isStandard(s.globalScrollPercent)){ gSel.value=String(s.globalScrollPercent); gWrap.classList.add("hidden"); } else { gSel.value="custom"; gWrap.classList.remove("hidden"); gIn.value=s.globalScrollPercent; }
  const cont=el("siteRules"); cont.innerHTML=""; (s.siteRules||[]).forEach(r=>cont.appendChild(createRuleRow(r)));
    el("autoSpeed").value=s.autoScroll.speed; el("autoSpeedVal").textContent=s.autoScroll.speed;
  await loadBookmarkFolders(s.bookmark.folderId);
  attachAutoSaveListeners();
}

async function loadBookmarkFolders(selectedId){
  const sel=el("bookmarkFolderSelect");
  sel.innerHTML=`<option>${i18n("loadingFolders")||"Loading..."}</option>`;
  try{
    const resp=await new Promise(r=>chrome.runtime.sendMessage({type:"GET_ALL_FOLDERS"}, x=>r(x)));
    if(!resp||!resp.ok) throw new Error(resp?.error||"failed");
    sel.innerHTML="";
    const def=document.createElement("option"); def.value=""; def.textContent=i18n("selectFolder")||"-- Select folder --"; sel.appendChild(def);
    resp.folders.forEach(f=>{ const o=document.createElement("option"); o.value=f.id; o.textContent=f.path; sel.appendChild(o); });
    if(selectedId) sel.value=selectedId;
  }catch(e){ sel.innerHTML=`<option>${i18n("getFailed", e.message)||"Failed"}</option>`; }
}

function collectSettings(){
  let gp; const gSel=el("globalSelect");
  if(gSel.value==="custom") gp=Number(el("globalCustomInput").value)||100; else gp=Number(gSel.value);
  const rules=[]; el("siteRules").querySelectorAll(".rule").forEach(row=>{
    const pat=row.querySelector(".rule-pattern").value.trim(); if(!pat) return;
    const sel=row.querySelector(".rule-select"); let pct; if(sel.value==="custom") pct=Number(row.querySelector(".rule-custom").value)||100; else pct=Number(sel.value);
    const en=row.querySelector(".rule-enabled").checked; rules.push({pattern:pat,scrollPercent:pct,enabled:en});
  });
  const method="instant";
  const speed=Number(el("autoSpeed").value)||1;
  const folderId=el("bookmarkFolderSelect").value||null;
  const folderTitle=el("bookmarkFolderSelect").selectedOptions[0]?.textContent||"";
  return { globalScrollPercent:gp, scrollMethod:method, siteRules:rules, autoScroll:{speed}, bookmark:{folderId, folderTitle} };
}

async function saveToStorage(showMsg=true){
  const settings=collectSettings();
  await chrome.storage.sync.set({settings});
  if(showMsg){
    const st=el("saveStatus"); const t=new Date().toLocaleTimeString();
    st.textContent=i18n("statusSaved", t)||`Saved ${t}`; st.className="status ok"; setTimeout(()=>{st.textContent="";},2500);
  }
  return settings;
}

async function saveToBookmarkIfNeeded(settings){
  if(!settings.bookmark.folderId){
    console.log("[Web Page Scroller] No folder selected, skip bookmark save");
    return;
  }
  // Always save, including folder info
  try{
    const resp = await new Promise(r=>chrome.runtime.sendMessage({type:"SAVE_TO_BOOKMARK", settings, folderId:settings.bookmark.folderId}, x=>r(x)));
    const statusEl=el("bookmarkStatus");
    if(resp && resp.ok){
      statusEl.textContent=i18n("savedBookmark")||"Bookmark saved"; statusEl.className="status ok";
      lastSavedFolderId = settings.bookmark.folderId;
      setTimeout(()=>{statusEl.textContent="";},3000);
    } else {
      statusEl.textContent=i18n("saveFailed", resp?.error||"")||"Save failed"; statusEl.className="status err";
    }
  }catch(e){
    console.error("[Web Page Scroller] Bookmark save error", e);
  }
}

function scheduleAutoSave(){
  if(saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer=setTimeout(async()=>{
    const s=await saveToStorage(true);
    // Also auto-save to bookmark on change if folder selected (for immediate persistence)
    if(s.bookmark.folderId){
      await saveToBookmarkIfNeeded(s);
    }
  },400);
}

function attachAutoSaveListeners(){
  ["globalSelect","globalCustomInput","autoSpeed","bookmarkFolderSelect"].forEach(id=>{
    const n=el(id); if(!n) return;
    n.addEventListener("change",scheduleAutoSave);
    n.addEventListener("input",scheduleAutoSave);
  });
    el("autoSpeed").addEventListener("input",e=>{ el("autoSpeedVal").textContent=e.target.value; });
}

document.addEventListener("DOMContentLoaded", loadSettings);
el("addRuleBtn").addEventListener("click",()=>{ el("siteRules").appendChild(createRuleRow()); scheduleAutoSave(); });

// Close auto-save: requirement - when options changed and closed, auto-save bookmark including folder info


window.addEventListener("beforeunload", ()=>{
  try{
    const s=collectSettings();
    chrome.storage.sync.set({settings:s});
  }catch{}
});

document.addEventListener("visibilitychange", ()=>{
  if(document.visibilityState==="hidden"){
    try{
      const s=collectSettings();
      chrome.storage.sync.set({settings:s});
    }catch{}
  }
});

