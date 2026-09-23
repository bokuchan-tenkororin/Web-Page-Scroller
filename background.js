const PREFIX = "__WEB_PAGE_SCROLLER_CONFIG__";
const CONFIG_URL_BASE = "https://web-page-scroller-config.local/";

function getDefaultSettings(){
  return {
    globalScrollPercent: 100,
    scrollMethod: "instant",
    siteRules: [],
    autoScroll: { speed: 1 },
    bookmark: { folderId: null, folderTitle: "" }
  };
}

async function getAllConfigBookmarks(){
  try{
    const tree = await chrome.bookmarks.getTree();
    const res = [];
    function walk(nodes){
      for(const n of nodes){
        if(n.url && n.title === PREFIX) res.push(n);
        if(n.children) walk(n.children);
      }
    }
    walk(tree);
    return res;
  }catch{ return []; }
}
async function getChildren(folderId){
  try{ return await chrome.bookmarks.getChildren(folderId); }catch{ return []; }
}
async function deduplicateKeepLatest(all){
  if(all.length <= 1) return all;
  all.sort((a,b)=>(b.dateAdded||0)-(a.dateAdded||0));
  const keep = all[0];
  for(let i=1;i<all.length;i++){
    try{ await chrome.bookmarks.remove(all[i].id); console.log("[Web Page Scroller] Dedup removed", all[i].id); }catch{}
  }
  return [keep];
}

let saveQueue = Promise.resolve();
function queueSave(fn){
  const result = saveQueue.then(fn, fn);
  saveQueue = result.catch(()=>{});
  return result;
}

async function _saveToBookmarkInternal(settings, folderId){
  if(!folderId) return null;
  try{ await chrome.bookmarks.get(folderId); }catch(e){ throw new Error("Folder not found: "+folderId); }
  const json = JSON.stringify(settings);
  const url = CONFIG_URL_BASE + "#config=" + encodeURIComponent(json);
  let all = await getAllConfigBookmarks();
  if(all.length === 0){
    const created = await chrome.bookmarks.create({ parentId: folderId, title: PREFIX, url: url });
    console.log("[Web Page Scroller] Created", created.id);
    all = await getAllConfigBookmarks();
    if(all.length > 1) await deduplicateKeepLatest(all);
    return created;
  } else {
    all.sort((a,b)=>(b.dateAdded||0)-(a.dateAdded||0));
    const latest = all[0];
    try{
      await chrome.bookmarks.update(latest.id, { title: PREFIX, url: url });
    }catch(e){
      console.error("[Web Page Scroller] Update failed, recreate", e);
      try{ await chrome.bookmarks.remove(latest.id); }catch{}
      const created = await chrome.bookmarks.create({ parentId: folderId, title: PREFIX, url: url });
      const after = await getAllConfigBookmarks();
      if(after.length > 1) await deduplicateKeepLatest(after);
      return created;
    }
    if(latest.parentId !== folderId){
      try{ await chrome.bookmarks.move(latest.id, { parentId: folderId }); }catch(e){ console.warn(e); }
    }
    for(let i=1;i<all.length;i++){
      try{ await chrome.bookmarks.remove(all[i].id); }catch{}
    }
    return latest;
  }
}
function saveToBookmark(settings, folderId){
  return queueSave(()=>_saveToBookmarkInternal(settings, folderId));
}

async function loadFromFolder(folderId){
  const children = await getChildren(folderId);
  const filtered = children.filter(b=>b.title === PREFIX);
  if(filtered.length===0) return null;
  filtered.sort((a,b)=>(b.dateAdded||0)-(a.dateAdded||0));
  if(filtered.length > 1){
    for(let i=1;i<filtered.length;i++){ try{ await chrome.bookmarks.remove(filtered[i].id); }catch{} }
  }
  const latest = filtered[0];
  try{
    const idx = latest.url.indexOf("#config=");
    if(idx===-1) return null;
    return JSON.parse(decodeURIComponent(latest.url.substring(idx+8)));
  }catch(e){ console.error(e); return null; }
}
async function loadFromAnywhere(){
  const all = await getAllConfigBookmarks();
  if(all.length===0) return null;
  if(all.length > 1){
    all.sort((a,b)=>(b.dateAdded||0)-(a.dateAdded||0));
    for(let i=1;i<all.length;i++){ try{ await chrome.bookmarks.remove(all[i].id); }catch{} }
  }
  const latest = all[0];
  try{
    const dec = decodeURIComponent(latest.url.substring(latest.url.indexOf("#config=")+8));
    return { settings: JSON.parse(dec), folderId: latest.parentId };
  }catch(e){ console.error(e); return null; }
}
async function loadOnStartup(){
  try{
    const all = await getAllConfigBookmarks();
    if(all.length > 1) await deduplicateKeepLatest(all);
    const {settings} = await chrome.storage.sync.get(["settings"]);
    let loaded = null;
    let folderId = settings?.bookmark?.folderId || null;
    if(folderId){
      loaded = await loadFromFolder(folderId);
      if(!loaded){
        const any = await loadFromAnywhere();
        if(any){ loaded = any.settings; folderId = any.folderId; }
      }
    } else {
      const any = await loadFromAnywhere();
      if(any){ loaded = any.settings; folderId = any.folderId; }
    }
    if(loaded){
      const merged = { ...getDefaultSettings(), ...loaded, bookmark: { folderId: folderId || loaded.bookmark?.folderId || null, folderTitle: loaded.bookmark?.folderTitle || settings?.bookmark?.folderTitle || "" } };
      await chrome.storage.sync.set({settings: merged});
    }
  }catch(e){ console.error(e); }
}

chrome.runtime.onStartup.addListener(()=>{ loadOnStartup(); });
chrome.runtime.onInstalled.addListener(async ()=>{
  const {settings} = await chrome.storage.sync.get(["settings"]);
  if(!settings) await chrome.storage.sync.set({settings: getDefaultSettings()});
  loadOnStartup();
});

// アイコンクリックで登録ダイアログを表示
function isRestrictedUrl(url){
  if(!url) return true;
  return url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("edge://") || url.startsWith("about:") || url.startsWith("moz-extension://") || url.startsWith("chrome-search://") || url.startsWith("view-source:");
}

chrome.action.onClicked.addListener(async (tab)=>{
  if(!tab?.id) return;
  const url = tab.url || "";
  if(isRestrictedUrl(url)){
    // chrome:// ページでは content script を注入できないのでオプションページを開く
    console.log("[Web Page Scroller] Restricted URL, opening options page:", url);
    try{ chrome.runtime.openOptionsPage(); }catch{}
    return;
  }
  try{
    await chrome.tabs.sendMessage(tab.id, {type:"SHOW_REGISTER_DIALOG"});
    return;
  }catch{}
  try{
    await chrome.scripting.executeScript({target:{tabId:tab.id}, files:["content.js"]});
    setTimeout(async()=>{
      try{ await chrome.tabs.sendMessage(tab.id, {type:"SHOW_REGISTER_DIALOG"}); }catch(e){ 
        // 注入失敗は制限URLが原因のことが多いので無視
        if(!String(e.message).includes("Cannot access")) console.warn("[Web Page Scroller] Dialog inject failed", e); 
      }
    }, 200);
  }catch(e){
    // chrome:// URL への注入エラーは無視
    if(String(e.message).includes("Cannot access a chrome:// URL") || String(e.message).includes("Cannot access a chrome-extension:// URL")){
      console.log("[Web Page Scroller] Cannot inject into restricted URL, opening options");
      try{ chrome.runtime.openOptionsPage(); }catch{}
    } else {
      console.error(e);
    }
  }
});

chrome.commands.onCommand.addListener(async (command)=>{
  if(command!=="toggle-auto-scroll") return;
  try{
    const tabs = await chrome.tabs.query({active:true, currentWindow:true});
    const tab = tabs[0];
    if(!tab?.id) return;
    const url = tab.url || "";
    if(isRestrictedUrl(url)){
      console.log("[Web Page Scroller] Restricted URL for auto-scroll:", url);
      return;
    }
    try{ await chrome.tabs.sendMessage(tab.id, {type:"TOGGLE_AUTO_SCROLL"}); return; }catch{}
    try{
      await chrome.scripting.executeScript({target:{tabId:tab.id}, files:["content.js"]});
      setTimeout(async()=>{
        try{ await chrome.tabs.sendMessage(tab.id, {type:"TOGGLE_AUTO_SCROLL"}); }
        catch{
          try{ await chrome.scripting.executeScript({ target:{tabId:tab.id}, func: ()=>{ window.__WEB_PAGE_SCROLLER_TOGGLE__?.(); } }); }catch{}
        }
      }, 150);
    }catch(e){
      if(!String(e.message).includes("Cannot access")) console.error(e);
    }
  }catch(e){ console.error(e); }
});

chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  (async()=>{
    if(msg.type==="SAVE_TO_BOOKMARK"){
      try{
        const bm = await saveToBookmark(msg.settings, msg.folderId);
        sendResponse({ok:true, bookmark:bm});
      }catch(e){ sendResponse({ok:false, error:e.message}); }
    } else if(msg.type==="GET_ALL_FOLDERS"){
      try{
        const tree = await chrome.bookmarks.getTree();
        const folders=[];
        function walk(nodes,path){
          for(const n of nodes){
            if(!n.url){
              const cur = path ? path+" / "+n.title : n.title;
              if(n.id!=="0") folders.push({id:n.id, title:n.title||"(Untitled)", path:cur});
              if(n.children) walk(n.children,cur);
            }
          }
        }
        walk(tree,"");
        sendResponse({ok:true, folders});
      }catch(e){ sendResponse({ok:false, error:e.message}); }
    } else if(msg.type==="DEDUPLICATE" || msg.type==="CLEANUP_DUPLICATES"){
      try{
        const all = await getAllConfigBookmarks();
        const kept = await deduplicateKeepLatest(all);
        sendResponse({ok:true, kept, count:kept.length});
      }catch(e){ sendResponse({ok:false, error:e.message}); }
    } else if(msg.type==="OPEN_OPTIONS"){
      try{ chrome.runtime.openOptionsPage(); sendResponse({ok:true}); }catch(e){ sendResponse({ok:false, error:e.message}); }
    }
  })();
  return true;
});
