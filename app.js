const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const STORAGE_KEY='arazFlowDatabase';
const BACKUP_KEY='arazFlowEmergencyBackups';
const LEGACY_KEYS=['arazFlowV11','aminDashboardV1'];
const DB_NAME='araz-flow-db';
const DB_STORE='app';
const DB_RECORD_KEY='state';
const DB_SNAPSHOT_KEY='snapshot:last';
const DB_PREVIOUS_SNAPSHOT_KEY='snapshot:previous';
const DB_SCHEMA_VERSION=5;
const APP_VERSION='2.0.0';
const APP_BUILD='006';
const VERSION_ENDPOINT='./version.json';
const defaultState={schemaVersion:DB_SCHEMA_VERSION,tasks:[],incoming:[],parking:[],notes:{},meta:{createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),revision:0}};
let saveQueue=Promise.resolve();
let changesSinceSnapshot=0;
let lastSnapshotAt=0;
let storageHealth={status:'checking',message:'در حال بررسی ذخیره‌سازی...'};
function safeParse(value){try{return value?JSON.parse(value):null}catch{return null}}
function clone(value){return typeof structuredClone==='function'?structuredClone(value):JSON.parse(JSON.stringify(value))}
function isValidState(value){return Boolean(value&&typeof value==='object'&&Array.isArray(value.tasks))}
function stateTime(value){const t=Date.parse(value?.meta?.updatedAt||value?.updatedAt||0);return Number.isFinite(t)?t:0}
function openDatabase(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,1);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(new Error('Database open blocked'));
  });
}
async function idbGet(key){
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(DB_STORE,'readonly');
    const req=tx.objectStore(DB_STORE).get(key);
    req.onsuccess=()=>resolve(req.result||null);
    req.onerror=()=>reject(req.error);
    tx.oncomplete=()=>db.close();
    tx.onabort=()=>{db.close();reject(tx.error||new Error('Database read aborted'))};
  });
}
async function idbSet(key,value){
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(DB_STORE,'readwrite');
    tx.objectStore(DB_STORE).put(value,key);
    tx.oncomplete=()=>{db.close();resolve()};
    tx.onerror=()=>{db.close();reject(tx.error)};
    tx.onabort=()=>{db.close();reject(tx.error||new Error('Database write aborted'))};
  });
}
async function idbDelete(key){
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(DB_STORE,'readwrite');
    tx.objectStore(DB_STORE).delete(key);
    tx.oncomplete=()=>{db.close();resolve()};
    tx.onerror=()=>{db.close();reject(tx.error)};
  });
}
function createEmergencyBackup(data,reason='پشتیبان خودکار'){
  try{
    const items=safeParse(localStorage.getItem(BACKUP_KEY))||[];
    items.unshift({createdAt:new Date().toISOString(),reason,data:clone(data)});
    localStorage.setItem(BACKUP_KEY,JSON.stringify(items.slice(0,5)));
  }catch(err){console.warn('Emergency backup failed',err)}
}
async function createIndexedSnapshot(data,reason='نسخه اضطراری خودکار'){
  const packet={createdAt:new Date().toISOString(),reason,data:clone(data)};
  try{
    const previous=await idbGet(DB_SNAPSHOT_KEY);
    if(previous) await idbSet(DB_PREVIOUS_SNAPSHOT_KEY,previous);
    await idbSet(DB_SNAPSHOT_KEY,packet);
    lastSnapshotAt=Date.now();
    changesSinceSnapshot=0;
  }catch(err){console.warn('Indexed snapshot failed',err)}
  createEmergencyBackup(data,reason);
}
async function loadState(){
  const candidates=[];
  try{
    const stored=await idbGet(DB_RECORD_KEY);
    if(isValidState(stored)) candidates.push({source:'IndexedDB',data:stored});
    const snap=await idbGet(DB_SNAPSHOT_KEY);
    if(isValidState(snap?.data)) candidates.push({source:'نسخه اضطراری',data:snap.data});
  }catch(err){console.warn('IndexedDB read failed',err)}
  const current=safeParse(localStorage.getItem(STORAGE_KEY));
  if(isValidState(current)) candidates.push({source:'ذخیره ایمنی مرورگر',data:current});
  for(const key of LEGACY_KEYS){
    const legacy=safeParse(localStorage.getItem(key));
    if(isValidState(legacy)) candidates.push({source:key,data:legacy});
  }
  if(!candidates.length) return clone(defaultState);
  candidates.sort((a,b)=>stateTime(b.data)-stateTime(a.data));
  const selected=clone(candidates[0].data);
  if(candidates[0].source!=='IndexedDB') createEmergencyBackup(selected,'بازیابی خودکار از '+candidates[0].source);
  try{await idbSet(DB_RECORD_KEY,selected);localStorage.setItem(STORAGE_KEY,JSON.stringify(selected))}catch{}
  return selected;
}
let state;
let draftActions=[];let editingTaskId=null;let pendingCompleteTaskId=null;
function normalize(){
  state=isValidState(state)?state:clone(defaultState);
  state.tasks=(state.tasks||[]).map(t=>({id:t.id||uid(),created:t.created||new Date().toISOString(),updated:t.updated||t.created||new Date().toISOString(),status:t.status||'backlog',priority:t.priority||'B',category:t.category||'سایر',owner:t.owner||'',due:t.due||'',note:t.note||'',...t,actions:Array.isArray(t.actions)?t.actions.map(a=>({id:a.id||uid(),text:String(a.text||''),done:Boolean(a.done)})):(t.next?[{id:uid(),text:t.next,done:false}]:[])}));
  state.incoming=Array.isArray(state.incoming)?state.incoming:[];
  state.parking=Array.isArray(state.parking)?state.parking:[];
  state.notes=state.notes&&typeof state.notes==='object'?state.notes:{};
  state.meta=state.meta&&typeof state.meta==='object'?state.meta:{};
  state.meta.createdAt=state.meta.createdAt||new Date().toISOString();
  state.meta.revision=Number(state.meta.revision)||0;
  state.schemaVersion=DB_SCHEMA_VERSION;
  save({forceSnapshot:true,reason:'مهاجرت یا راه‌اندازی Build 006'});
}
function save(options={}){
  if(!state)return Promise.resolve();
  state.schemaVersion=DB_SCHEMA_VERSION;
  state.meta=state.meta||{};
  state.meta.updatedAt=new Date().toISOString();
  state.meta.revision=(Number(state.meta.revision)||0)+1;
  const packet=clone(state);
  changesSinceSnapshot++;

  // حیاتی: نسخه ایمنی را همین لحظه و به‌صورت همگام می‌نویسیم.
  // در Build 002 نوشتن localStorage داخل Promise انجام می‌شد و اگر کاربر
  // بلافاصله صفحه را می‌بست، مرورگر ممکن بود پیش از اجرای صف، صفحه را نابود کند.
  let immediateLocalOk=false;
  try{
    localStorage.setItem(STORAGE_KEY,JSON.stringify(packet));
    const immediateCheck=safeParse(localStorage.getItem(STORAGE_KEY));
    immediateLocalOk=isValidState(immediateCheck)&&immediateCheck.meta?.revision===packet.meta?.revision;
  }catch(err){console.error('Immediate safety storage write failed',err)}

  saveQueue=saveQueue.then(async()=>{
    let localOk=immediateLocalOk,idbOk=false;
    if(!localOk){
      try{
        localStorage.setItem(STORAGE_KEY,JSON.stringify(packet));
        const check=safeParse(localStorage.getItem(STORAGE_KEY));
        localOk=isValidState(check)&&check.meta?.revision===packet.meta?.revision;
      }catch(err){console.error('Safety storage retry failed',err)}
    }
    try{
      await idbSet(DB_RECORD_KEY,packet);
      const check=await idbGet(DB_RECORD_KEY);
      idbOk=isValidState(check)&&check.meta?.revision===packet.meta?.revision;
    }catch(err){console.error('IndexedDB write failed',err)}
    if(!localOk&&!idbOk){
      storageHealth={status:'error',message:'ذخیره‌سازی ناموفق بود؛ فعلاً اطلاعات جدید وارد نکن.'};
    }else if(localOk&&idbOk){
      storageHealth={status:'ok',message:'اطلاعات در دو محل ذخیره و کنترل شد.'};
    }else{
      storageHealth={status:'warning',message:'اطلاعات فقط در یکی از دو محل ذخیره شد؛ پشتیبان بگیر.'};
    }
    const snapshotDue=options.forceSnapshot||changesSinceSnapshot>=5||(Date.now()-lastSnapshotAt)>10*60*1000;
    if(snapshotDue&&(localOk||idbOk)) await createIndexedSnapshot(packet,options.reason||'نسخه اضطراری خودکار');
    updateBackupPanel();
  }).catch(err=>{
    console.error('Save queue failed',err);
    storageHealth={status:'error',message:'خطا در صف ذخیره‌سازی؛ یک فایل پشتیبان بگیر.'};
    updateBackupPanel();
  });
  return saveQueue;
}
async function flushSaves(){await saveQueue}
async function testStorage(){
  storageHealth={status:'checking',message:'در حال آزمایش نوشتن و خواندن...'};updateBackupPanel();
  const probe={token:uid(),createdAt:new Date().toISOString()};
  let localOk=false,idbOk=false;
  try{localStorage.setItem('arazFlowStorageProbe',JSON.stringify(probe));localOk=safeParse(localStorage.getItem('arazFlowStorageProbe'))?.token===probe.token;localStorage.removeItem('arazFlowStorageProbe')}catch{}
  try{await idbSet('storage:probe',probe);idbOk=(await idbGet('storage:probe'))?.token===probe.token;await idbDelete('storage:probe')}catch{}
  if(localOk&&idbOk) storageHealth={status:'ok',message:'آزمایش موفق: هر دو محل ذخیره‌سازی سالم‌اند.'};
  else if(localOk||idbOk) storageHealth={status:'warning',message:'فقط یکی از دو محل ذخیره‌سازی سالم است.'};
  else storageHealth={status:'error',message:'آزمایش ناموفق: فعلاً داده واقعی وارد نکن.'};
  updateBackupPanel();
  return localOk&&idbOk;
}
async function restoreLatestEmergency(){
  let packet=null;
  try{packet=await idbGet(DB_SNAPSHOT_KEY)}catch{}
  if(!isValidState(packet?.data)){
    const items=safeParse(localStorage.getItem(BACKUP_KEY))||[];
    packet=items.find(x=>isValidState(x.data))||null;
  }
  if(!packet)return alert('نسخه اضطراری قابل بازیابی پیدا نشد.');
  if(!confirm(`نسخه اضطراری مربوط به ${new Date(packet.createdAt).toLocaleString('fa-IR')} بازیابی شود؟`))return;
  createEmergencyBackup(state,'قبل از بازیابی نسخه اضطراری');
  state=clone(packet.data);
  normalize();render();toast('نسخه اضطراری بازیابی شد');
}
function esc(s=''){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,7)}
function now(){return new Date().toISOString()}
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1800)}
function activeAction(t){return (t.actions||[]).find(a=>!a.done)}
function doneCount(t){return (t.actions||[]).filter(a=>a.done).length}
function progressPct(t){return t.actions?.length?Math.round(doneCount(t)/t.actions.length*100):0}
let latestServerVersion=null;
let lastVersionCheckAt=0;
function buildNumber(value){const n=Number.parseInt(String(value||'0').replace(/\D/g,''),10);return Number.isFinite(n)?n:0;}
function setUpdateStatus(status,message){
  const box=$('#updateStatus');
  if(box){box.className='storage-health '+status;box.textContent=message;}
}
async function fetchServerVersion(){
  const response=await fetch(`${VERSION_ENDPOINT}?t=${Date.now()}`,{cache:'no-store',headers:{'Cache-Control':'no-cache','Pragma':'no-cache'}});
  if(!response.ok)throw new Error(`Version check failed: ${response.status}`);
  const info=await response.json();
  if(!info||!info.build)throw new Error('Invalid version file');
  return info;
}
async function checkForUpdates({silent=false}={}){
  lastVersionCheckAt=Date.now();
  if(!silent)setUpdateStatus('checking','در حال بررسی نسخه منتشرشده...');
  try{
    const info=await fetchServerVersion();
    latestServerVersion=info;
    const badge=$('#serverBuildBadge');
    if(badge)badge.innerHTML=`نسخه سرور: <b>${esc(info.version||APP_VERSION)} • Build ${esc(info.build)}</b>`;
    const newer=buildNumber(info.build)>buildNumber(APP_BUILD);
    if(newer){
      setUpdateStatus('warning',`Build ${info.build} آماده نصب است.`);
      const text=$('#updateDialogText');
      if(text)text.innerHTML=`نسخه <b>${esc(info.version||APP_VERSION)} • Build ${esc(info.build)}</b> آماده است.${info.notes?`<br><span class="meta">${esc(info.notes)}</span>`:''}`;
      if(!$('#updateDialog').open)$('#updateDialog').showModal();
      return true;
    }
    setUpdateStatus('ok',`آخرین نسخه نصب است: Build ${APP_BUILD}`);
    if(!silent)toast('آخرین نسخه را داری');
    return false;
  }catch(err){
    console.warn('Version check failed',err);
    setUpdateStatus('warning','بررسی نسخه ممکن نشد؛ اتصال اینترنت را بررسی کن.');
    if(!silent)toast('بررسی به‌روزرسانی انجام نشد');
    return false;
  }
}
async function applyAvailableUpdate(){
  const target=latestServerVersion?.build;
  if(!target)return checkForUpdates();
  setUpdateStatus('checking',`در حال آماده‌سازی Build ${target}...`);
  emergencySyncWrite('قبل از به‌روزرسانی برنامه');
  try{await flushSaves();}catch{}
  try{createEmergencyBackup(state,`قبل از به‌روزرسانی به Build ${target}`);}catch{}
  try{
    if('serviceWorker' in navigator){
      const regs=await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r=>r.unregister()));
    }
    if('caches' in window){
      const keys=await caches.keys();
      await Promise.all(keys.map(k=>caches.delete(k)));
    }
  }catch(err){console.warn('Update cleanup failed',err)}
  const base=new URL('./',location.href);
  base.searchParams.set('build',String(target));
  base.searchParams.set('refresh',String(Date.now()));
  location.replace(base.href);
}
async function initApp(){
  state=await loadState();
  normalize();

$$('.tab').forEach(b=>b.onclick=()=>{$$('.tab').forEach(x=>x.classList.remove('active'));$$('.section').forEach(x=>x.classList.remove('active'));b.classList.add('active');$('#'+b.dataset.tab).classList.add('active');render();});

function renderDraftActions(){const box=$('#newActions');box.innerHTML=draftActions.map((a,i)=>`<div class="step-row"><span class="step-num">${i+1}</span><input value="${esc(a.text)}" oninput="updateDraftAction(${i},this.value)"><div class="step-tools"><button class="mini" onclick="moveDraft(${i},-1)">↑</button><button class="mini" onclick="moveDraft(${i},1)">↓</button><button class="mini" onclick="removeDraft(${i})">حذف</button></div></div>`).join('');}
window.updateDraftAction=(i,v)=>{draftActions[i].text=v};window.removeDraft=i=>{draftActions.splice(i,1);renderDraftActions()};window.moveDraft=(i,d)=>{let j=i+d;if(j<0||j>=draftActions.length)return;[draftActions[i],draftActions[j]]=[draftActions[j],draftActions[i]];renderDraftActions()};
$('#addNewAction').onclick=()=>{let v=$('#newActionText').value.trim();if(!v)return;draftActions.push({id:uid(),text:v,done:false});$('#newActionText').value='';renderDraftActions()};
$('#newActionText').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('#addNewAction').click()}});

$('#addTask').onclick=()=>{let title=$('#taskTitle').value.trim();if(!title)return alert('عنوان پروژه یا کار را بنویس.');let acts=draftActions.filter(a=>a.text.trim()).map(a=>({...a,text:a.text.trim()}));state.tasks.unshift({id:uid(),title,category:$('#taskCategory').value,priority:$('#taskPriority').value,owner:$('#taskOwner').value.trim(),due:$('#taskDue').value,note:$('#taskNote').value.trim(),actions:acts,status:'backlog',created:now(),updated:now()});['#taskTitle','#taskOwner','#taskDue','#taskNote'].forEach(x=>$(x).value='');draftActions=[];renderDraftActions();save();render();toast('در پروژه‌های جاری ثبت شد');};

function priorityRank(priority){return ({A:3,B:2,C:1})[priority]||1;}
function priorityStars(priority){return '★'.repeat(priorityRank(priority));}
function priorityLabel(priority){return ({A:'بحرانی',B:'مهم',C:'عادی'})[priority]||'عادی';}
function compareProjects(a,b){const ah=Boolean(a.due),bh=Boolean(b.due);if(ah!==bh)return ah?-1:1;if(ah&&bh){const d=String(a.due).localeCompare(String(b.due));if(d)return d;}const p=priorityRank(b.priority)-priorityRank(a.priority);if(p)return p;return new Date(a.created||0)-new Date(b.created||0);}
function taskCard(t){const a=activeAction(t),pct=progressPct(t),statusLabel={backlog:'پروژه‌های جاری',today:'امروز',waiting:'در انتظار',done:'انجام‌شده'}[t.status]||t.status;return `<div class="item"><div class="item-head"><div><div class="title">${esc(t.title)}</div><div class="meta">${esc(t.category)} ${t.owner?'• مسئول: '+esc(t.owner):''} ${t.due?'• مهلت: '+esc(t.due):''} • وضعیت: ${statusLabel}</div></div><span class="badge ${t.priority}" title="${priorityLabel(t.priority)}">${priorityStars(t.priority)}</span></div>
${a?`<div class="active-action"><b>اقدام فعال:</b> ${esc(a.text)}</div>`:`<div class="active-action"><b>${t.status==='done'?'پروژه تکمیل شده':'اقدام انجام‌نشده‌ای ثبت نشده'}</b></div>`}
<div class="action-count">${doneCount(t)} اقدام انجام‌شده از ${t.actions.length}</div><div class="progress"><span style="width:${pct}%"></span></div>${t.note?`<div class="meta">${esc(t.note)}</div>`:''}
<div class="actions">${t.status!=='today'&&t.status!=='done'?`<button class="iconbtn primary" onclick="moveToday('${t.id}')">ورود به امروز</button>`:''}${t.status==='today'&&a?`<button class="iconbtn primary" onclick="completeActive('${t.id}')">✓ انجام اقدام فعال</button>`:''}${t.status==='today'?`<button class="iconbtn" onclick="setStatus('${t.id}','waiting')">در انتظار</button>`:''}<button class="iconbtn" onclick="openProject('${t.id}')">جزئیات و اقدامات</button>${t.status!=='done'?`<button class="iconbtn" onclick="setStatus('${t.id}','done')">اتمام پروژه</button>`:''}<button class="iconbtn" onclick="setStatus('${t.id}','backlog')">بازگشت به مخزن</button><button class="iconbtn danger" onclick="delTask('${t.id}')">حذف</button></div></div>`}
window.moveToday=id=>{let t=state.tasks.find(x=>x.id===id);if(!t)return;if(state.tasks.filter(x=>x.status==='today').length>=5)return alert('حداکثر پنج محور فعال. مغزت شعبه نامحدود ندارد.');if(!activeAction(t))return openProject(id);t.status='today';t.updated=now();save();render();toast('به امروز منتقل شد')};
window.setStatus=(id,status)=>{let t=state.tasks.find(x=>x.id===id);if(t){t.status=status;t.updated=now()}save();render();};
window.delTask=id=>{if(!confirm('این پروژه حذف شود؟'))return;state.tasks=state.tasks.filter(x=>x.id!==id);save();render();};

window.completeActive=id=>{const t=state.tasks.find(x=>x.id===id),a=t&&activeAction(t);if(!t||!a)return;a.done=true;t.updated=now();pendingCompleteTaskId=id;save();showNextActionDialog(t);};
function showNextActionDialog(t){const next=activeAction(t),content=$('#nextActionContent'),buttons=$('#nextActionButtons');if(next){content.innerHTML=`<div class="notice">اقدام انجام شد.</div><p>اقدام بعدی پروژه:</p><div class="active-action"><b>${esc(next.text)}</b></div><p class="meta">می‌خواهی همین پروژه امروز ادامه پیدا کند یا به مخزن برگردد؟</p>`;buttons.innerHTML=`<button class="btn secondary" onclick="sendCompletedToBacklog()">بازگشت به مخزن</button><button class="btn teal" onclick="keepNextToday()">ادامه همین پروژه امروز</button>`;}else{content.innerHTML=`<div class="notice">همه اقدامات ثبت‌شده انجام شدند.</div><p>وضعیت پروژه چیست؟</p>`;buttons.innerHTML=`<button class="btn secondary" onclick="sendCompletedToBacklog()">فعلاً به مخزن برگردد</button><button class="btn gold" onclick="addActionAfterFinish()">اقدام جدید اضافه می‌کنم</button><button class="btn teal" onclick="finishProjectNow()">پروژه تکمیل شد</button>`;}$('#nextActionDialog').showModal();render();}
window.keepNextToday=()=>{let t=state.tasks.find(x=>x.id===pendingCompleteTaskId);if(t){t.status='today';t.updated=now()}save();$('#nextActionDialog').close();pendingCompleteTaskId=null;render();toast('اقدام بعدی برای امروز فعال شد')};
window.sendCompletedToBacklog=()=>{let t=state.tasks.find(x=>x.id===pendingCompleteTaskId);if(t){t.status='backlog';t.updated=now()}save();$('#nextActionDialog').close();pendingCompleteTaskId=null;render();toast('پروژه به مخزن برگشت')};
window.finishProjectNow=()=>{let t=state.tasks.find(x=>x.id===pendingCompleteTaskId);if(t){t.status='done';t.updated=now()}save();$('#nextActionDialog').close();pendingCompleteTaskId=null;render();toast('پروژه تکمیل شد')};
window.addActionAfterFinish=()=>{let id=pendingCompleteTaskId;$('#nextActionDialog').close();pendingCompleteTaskId=null;openProject(id);setTimeout(()=>$('#editActionText').focus(),100)};

window.openProject=id=>{editingTaskId=id;const t=state.tasks.find(x=>x.id===id);if(!t)return;$('#projectDialogTitle').textContent='جزئیات پروژه';$('#editTitle').value=t.title;$('#editCategory').value=t.category;$('#editPriority').value=t.priority;$('#editOwner').value=t.owner||'';$('#editDue').value=t.due||'';$('#editNote').value=t.note||'';renderEditActions();$('#projectDialog').showModal();};
function renderEditActions(){const t=state.tasks.find(x=>x.id===editingTaskId);if(!t)return;$('#editActions').innerHTML=t.actions.map((a,i)=>`<div class="step-row ${a.done?'done':''}"><span class="step-num">${a.done?'✓':i+1}</span><input value="${esc(a.text)}" oninput="editActionTextChange(${i},this.value)"><div class="step-tools"><button class="mini" onclick="toggleEditDone(${i})">${a.done?'بازگردانی':'انجام شد'}</button><button class="mini" onclick="moveEditAction(${i},-1)">↑</button><button class="mini" onclick="moveEditAction(${i},1)">↓</button><button class="mini" onclick="removeEditAction(${i})">حذف</button></div></div>`).join('');}
window.editActionTextChange=(i,v)=>{let t=state.tasks.find(x=>x.id===editingTaskId);if(t)t.actions[i].text=v};window.toggleEditDone=i=>{let t=state.tasks.find(x=>x.id===editingTaskId);if(t)t.actions[i].done=!t.actions[i].done;renderEditActions()};window.moveEditAction=(i,d)=>{let t=state.tasks.find(x=>x.id===editingTaskId);if(!t)return;let j=i+d;if(j<0||j>=t.actions.length)return;[t.actions[i],t.actions[j]]=[t.actions[j],t.actions[i]];renderEditActions()};window.removeEditAction=i=>{let t=state.tasks.find(x=>x.id===editingTaskId);if(!t)return;t.actions.splice(i,1);renderEditActions()};
$('#addEditAction').onclick=()=>{let v=$('#editActionText').value.trim(),t=state.tasks.find(x=>x.id===editingTaskId);if(!v||!t)return;t.actions.push({id:uid(),text:v,done:false});$('#editActionText').value='';renderEditActions()};
$('#editActionText').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('#addEditAction').click()}});
$('#closeProject').onclick=()=>{$('#projectDialog').close();editingTaskId=null};
$('#saveProject').onclick=()=>{let t=state.tasks.find(x=>x.id===editingTaskId);if(!t)return;t.title=$('#editTitle').value.trim()||t.title;t.category=$('#editCategory').value;t.priority=$('#editPriority').value;t.owner=$('#editOwner').value.trim();t.due=$('#editDue').value;t.note=$('#editNote').value.trim();t.actions=t.actions.filter(a=>a.text.trim()).map(a=>({...a,text:a.text.trim()}));t.updated=now();save();$('#projectDialog').close();editingTaskId=null;render();toast('تغییرات ذخیره شد')};

function renderTasks(){let q=$('#searchTask')?.value?.toLowerCase()||'',f=$('#filterStatus')?.value||'all';let sorted=[...state.tasks].sort(compareProjects);let all=sorted.filter(t=>(f==='all'||t.status===f)&&JSON.stringify(t).toLowerCase().includes(q));$('#backlogList').innerHTML=all.map(taskCard).join('');$('#backlogEmpty').style.display=all.length?'none':'block';let today=sorted.filter(t=>t.status==='today');$('#todayList').innerHTML=today.map(taskCard).join('');$('#todayEmpty').style.display=today.length?'none':'block';$('#activeCount').textContent=`${today.length}/۵`;}
$('#searchTask').oninput=renderTasks;$('#filterStatus').onchange=renderTasks;

$('#addIncoming').onclick=()=>{let name=$('#inName').value.trim(),topic=$('#inTopic').value.trim();if(!name&&!topic)return alert('حداقل نام یا موضوع را وارد کن.');state.incoming.unshift({id:uid(),name,topic,priority:$('#inPriority').value,decision:$('#inDecision').value.trim(),delegate:$('#inDelegate').value.trim(),follow:$('#inFollow').value,done:false});['#inName','#inTopic','#inDecision','#inDelegate','#inFollow'].forEach(x=>$(x).value='');save();render();};
function renderIncoming(){let a=state.incoming;$('#incomingList').innerHTML=a.map(x=>`<div class="item"><div class="item-head"><div><div class="title">${esc(x.name||'بدون نام')} • ${esc(x.topic||'بدون موضوع')}</div><div class="meta">${x.decision?'تصمیم: '+esc(x.decision):'بدون تصمیم'} ${x.delegate?'• ارجاع: '+esc(x.delegate):''} ${x.follow?'• پیگیری: '+esc(x.follow):''}</div></div><span class="badge ${x.priority}">${x.priority}</span></div><div class="actions"><button class="iconbtn" onclick="incomingToTask('${x.id}')">تبدیل به پروژه</button><button class="iconbtn danger" onclick="delIncoming('${x.id}')">حذف</button></div></div>`).join('');$('#incomingEmpty').style.display=a.length?'none':'block';}
window.incomingToTask=id=>{let x=state.incoming.find(y=>y.id===id);if(!x)return;state.tasks.unshift({id:uid(),title:x.topic||('پیگیری '+x.name),category:'سایر',priority:x.priority,owner:x.delegate,due:x.follow,note:'ورودی از '+x.name,actions:x.decision?[{id:uid(),text:x.decision,done:false}]:[],status:'backlog',created:now(),updated:now()});save();render();toast('به پروژه‌های جاری منتقل شد')};window.delIncoming=id=>{state.incoming=state.incoming.filter(x=>x.id!==id);save();render();};

$('#addParking').onclick=()=>{let text=$('#parkText').value.trim();if(!text)return;state.parking.unshift({id:uid(),text});$('#parkText').value='';save();render();};
function renderParking(){let a=state.parking;$('#parkingList').innerHTML=a.map(x=>`<div class="item"><div class="title">${esc(x.text)}</div><div class="actions"><button class="iconbtn" onclick="parkingToTask('${x.id}')">انتقال به پروژه‌های جاری</button><button class="iconbtn danger" onclick="delParking('${x.id}')">حذف</button></div></div>`).join('');$('#parkingEmpty').style.display=a.length?'none':'block';}
window.parkingToTask=id=>{let x=state.parking.find(y=>y.id===id);if(!x)return;state.tasks.unshift({id:uid(),title:x.text,category:'ایده و توسعه',priority:'C',owner:'',due:'',note:'',actions:[],status:'backlog',created:now(),updated:now()});state.parking=state.parking.filter(y=>y.id!==id);save();render();};window.delParking=id=>{state.parking=state.parking.filter(x=>x.id!==id);save();render();};

['focusText','reviewProgress','reviewDelegate','reviewWin'].forEach(id=>{$('#'+id).value=state.notes[id]||'';$('#'+id).oninput=e=>{state.notes[id]=e.target.value;save();}});
$('#brainLock').onclick=()=>$('#brainDialog').showModal();$('#closeBrain').onclick=()=>$('#brainDialog').close();$('#showStep').onclick=()=>{let v=$('#brainNext').value.trim();if(!v)return alert('کوچک‌ترین قدم بعدی را بنویس.');$('#singleStep').textContent='فقط همین کار: '+v;$('#singleStep').style.display='block';};$('#printToday').onclick=()=>print();
function backupPayload(){return {app:'Araz Flow',appVersion:APP_VERSION,schemaVersion:DB_SCHEMA_VERSION,exportedAt:new Date().toISOString(),data:state};}
function backupFilename(){const d=new Date(),pad=n=>String(n).padStart(2,'0');return `araz-flow-backup-${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;}
function backupBlob(){return new Blob([JSON.stringify(backupPayload(),null,2)],{type:'application/json'});}
function downloadBackup(){const blob=backupBlob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=backupFilename();document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);localStorage.setItem('arazFlowLastBackupAt',new Date().toISOString());updateBackupPanel();toast('فایل پشتیبان ساخته شد');}
$('#exportBackup').onclick=downloadBackup;
$('#shareBackup').onclick=async()=>{const file=new File([backupBlob()],backupFilename(),{type:'application/json'});try{if(navigator.canShare?.({files:[file]})){await navigator.share({title:'پشتیبان Araz Flow',files:[file]});localStorage.setItem('arazFlowLastBackupAt',new Date().toISOString());updateBackupPanel();}else downloadBackup();}catch(e){if(e.name!=='AbortError')downloadBackup();}};
$('#chooseRestore').onclick=()=>$('#restoreFile').click();
$('#restoreFile').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{const parsed=JSON.parse(await file.text());const incoming=parsed.data||parsed;if(!incoming||!Array.isArray(incoming.tasks))throw new Error('ساختار فایل معتبر نیست');if(!confirm(`اطلاعات فعلی با فایل «${file.name}» جایگزین شود؟`))return;createEmergencyBackup(state,'قبل از بازیابی فایل '+file.name);state=incoming;normalize();render();toast('اطلاعات با موفقیت بازیابی شد');}catch(err){alert('فایل پشتیبان معتبر نیست یا قابل خواندن نیست.');}finally{e.target.value='';}};
function updateBackupPanel(){const info=$('#backupInfo'),stats=$('#dataStats');if(!info||!stats||!state)return;const last=localStorage.getItem('arazFlowLastBackupAt');info.textContent=last?'آخرین فایل پشتیبان: '+new Date(last).toLocaleString('fa-IR'):'هنوز فایل پشتیبان نگرفته‌ای.';const done=state.tasks.filter(t=>t.status==='done').length;stats.innerHTML=`<span class="badge">${state.tasks.length} پروژه</span><span class="badge">${state.tasks.reduce((n,t)=>n+(t.actions?.length||0),0)} اقدام</span><span class="badge">${state.incoming.length} ورودی</span><span class="badge">${state.parking.length} مورد پارک‌شده</span><span class="badge">${done} پروژه تکمیل‌شده</span>`;$('#schemaVersionText').textContent=state.schemaVersion||DB_SCHEMA_VERSION;const health=$('#storageHealth');if(health){health.className='storage-health '+storageHealth.status;health.textContent=storageHealth.message;}const revision=$('#revisionText');if(revision)revision.textContent=state.meta?.revision||0;}
$('#testStorage').onclick=async()=>{const ok=await testStorage();toast(ok?'ذخیره‌سازی سالم است':'آزمایش ذخیره‌سازی ناموفق بود')};
$('#restoreEmergency').onclick=restoreLatestEmergency;
function render(){renderTasks();renderIncoming();renderParking();updateBackupPanel();}renderDraftActions();render();
setTimeout(testStorage,400);
let deferredInstallPrompt=null;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;});
function emergencySyncWrite(reason){
  if(!state)return;
  try{
    state.meta=state.meta||{};
    state.meta.updatedAt=new Date().toISOString();
    localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
    createEmergencyBackup(state,reason);
  }catch(err){console.warn('Emergency synchronous write failed',err)}
}
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='hidden') emergencySyncWrite('خروج از برنامه');
});
window.addEventListener('pagehide',()=>emergencySyncWrite('بسته شدن صفحه'));
$('#checkUpdate').onclick=()=>checkForUpdates();
$('#updateLater').onclick=()=>$('#updateDialog').close();
$('#updateNow').onclick=applyAvailableUpdate;
$('#installedBuildText').textContent=APP_BUILD;
setTimeout(()=>checkForUpdates({silent:true}),1800);
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&(Date.now()-lastVersionCheckAt)>15*60*1000)checkForUpdates({silent:true});
});
if('serviceWorker' in navigator){
  navigator.serviceWorker.register(`./sw.js?v=${APP_BUILD}`,{scope:'./',updateViaCache:'none'}).catch(err=>console.warn('Service worker registration failed',err));
}
}
initApp().catch(err=>{console.error(err);alert('راه‌اندازی دیتابیس با خطا روبه‌رو شد. صفحه را دوباره باز کن.');});
