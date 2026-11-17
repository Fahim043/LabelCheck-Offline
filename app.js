/* LabelCheck: standalone, local-only annotation validator.
   File access through Chrome/Edge File System Access API; no network requests. */
(() => {
  'use strict';
  const M = window.LabelCheckModel;
  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const ALLOWED = /\.(jpg|jpeg|png|webp|bmp|gif)$/i;
  const state = {
    datasets: [], images: [], active: -1, img: null, imgURL: null,
    doc: null, source: null, labelHandle: null, dirty: false,
    selected: -1, tool: 'select', draft: [], drag: null,
    zoom: 1, panX: 0, panY: 0, fitScale: 1, originX: 0, originY: 0,
    showOverlay: true, filter: 'all', search: '',
    undo: [], redo: [], pendingSnapshot: null, loadingToken: 0,
    reviewed: loadReviews(), copied: new Set(), toastTimer: null, lastPolygonClick: null,
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clamp = M.clamp;
  const getCurrent = () => state.images[state.active] || null;
  const datasetFor = (image) => image && state.datasets.find(d => d.id === image.datasetId);
  const annotations = () => state.doc ? state.doc.entries.map((a,i) => ({a,i})).filter(o => o.a.kind !== 'raw') : [];
  const selectedAnno = () => (state.doc && state.doc.entries[state.selected]?.kind !== 'raw') ? state.doc.entries[state.selected] : null;
  const colorFor = (id) => `hsl(${(id * 71 + 226) % 360} 85% 70%)`;
  const className = (id) => {
    const ds = datasetFor(getCurrent());
    return ds?.classes[id] || `Class ${id}`;
  };
  const shortType = (kind) => ({box:'BOX',polygon:'POLYGON',point:'POINT'}[kind] || 'UNKNOWN');
  const reviewKey = (image) => `labelcheck-review-v1:${image.datasetName}/${image.rel}`;
  function loadReviews() { try { return JSON.parse(localStorage.getItem('labelcheck-reviews-v1') || '{}'); } catch { return {}; } }
  function storeReviews() { try { localStorage.setItem('labelcheck-reviews-v1',JSON.stringify(state.reviewed)); } catch {} }
  function toast(message, error=false) {
    const el = $('messageToast'); el.textContent = message; el.classList.remove('hidden'); el.classList.toggle('error',error);
    clearTimeout(state.toastTimer); state.toastTimer=setTimeout(()=>el.classList.add('hidden'),4300);
  }
  function fileRootHint() {
    toast('Open this app in up-to-date Google Chrome or Microsoft Edge. Safari/Firefox cannot save directly to local folders.',true);
  }
  function showEmpty(show) { $('emptyState').classList.toggle('hidden',!show); }
  async function getNestedFile(dir, relative, create=false) {
    const parts = relative.split('/'); let cur=dir;
    try {
      for (const part of parts.slice(0,-1)) cur=await cur.getDirectoryHandle(part,{create});
      return await cur.getFileHandle(parts[parts.length-1],{create});
    } catch (err) { if (!create && err.name === 'NotFoundError') return null; throw err; }
  }
  async function scanImages(dir, prefix='') {
    const output=[];
    for await (const [name,handle] of dir.entries()) {
      if (name.startsWith('.')) continue;
      const rel=prefix ? `${prefix}/${name}` : name;
      if (handle.kind==='directory') output.push(...await scanImages(handle,rel));
      else if (ALLOWED.test(name)) output.push({rel,handle,labelRel: rel.replace(/\.[^.]+$/,'.txt')});
    }
    return output;
  }
  async function readClasses(handle) {
    for (const filename of ['classes.txt','obj.names']) {
      try {
        const f=await handle.getFileHandle(filename);
        const text=await (await f.getFile()).text();
        const classes=text.split(/\r?\n/).map(x=>x.trim()).filter(x=>x && !x.startsWith('#'));
        if(classes.length) return classes;
      } catch(err) { if (err.name !== 'NotFoundError') throw err; }
    }
    return [];
  }
  async function addDataset() {
    if (typeof window.showDirectoryPicker !== 'function') { fileRootHint();return; }
    try {
      // Must be called inside the user-click stack: browsers require a transient user gesture.
      const handle=await window.showDirectoryPicker({id:'labelcheck-dataset',mode:'readwrite'});
      await registerDataset(handle);
    } catch (err) {
      if (err.name !== 'AbortError') toast(`Could not open folder: ${err.message}`,true);
    }
  }
  async function registerDataset(handle) {
    for (const ds of state.datasets) {
      if (typeof ds.root.isSameEntry === 'function' && await ds.root.isSameEntry(handle)) {
        toast('That folder is already open.');return;
      }
    }
    let imgDir, labelDir;
    try { imgDir=await handle.getDirectoryHandle('images'); labelDir=await handle.getDirectoryHandle('labels'); }
    catch { toast(`"${handle.name}" is not a dataset root. Select the folder containing both images/ and labels/.`,true);return; }
    toast(`Scanning ${handle.name} locally...`);
    const entries=await scanImages(imgDir);
    entries.sort((a,b)=>a.rel.localeCompare(b.rel,undefined,{numeric:true,sensitivity:'base'}));
    if(!entries.length) {toast('No supported image files found in images/.',true);return;}
    const classes=await readClasses(handle);
    const id=crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${state.datasets.length}`;
    const ds={id,name:handle.name,root:handle,imagesDir:imgDir,labelsDir:labelDir,classes,images:[]};
    ds.images=entries.map(e=>({...e,datasetName:ds.name,datasetId:id}));
    state.datasets.push(ds); state.images.push(...ds.images);
    state.images.sort((a,b)=>a.datasetName.localeCompare(b.datasetName)||a.rel.localeCompare(b.rel,undefined,{numeric:true}));
    renderDatasets();renderQueue();
    toast(`Opened ${handle.name}: ${entries.length} images, ${classes.length} classes.`);
    if(state.active===-1) await openImage(state.images.indexOf(ds.images[0]));
    else updateSummary();
  }
  function removeDataset(id) {
    const ds=state.datasets.find(x=>x.id===id); if (!ds) return;
    state.datasets=state.datasets.filter(x=>x.id!==id);
    const former=getCurrent();
    state.images=state.images.filter(im=>im.datasetId!==id);
    const target=former && state.images.indexOf(former);
    if (former && former.datasetId === id) {
      state.active=-1;clearImage();
      if(state.images.length) openImage(0);
    } else state.active=target===undefined ? -1 : target;
    renderDatasets();renderQueue();updateSummary();
  }
  function renderDatasets() {
    const currentDS=getCurrent()?.datasetId;
    $('datasetList').innerHTML=state.datasets.length ? state.datasets.map(ds=>
      `<div class="dataset-item ${ds.id===currentDS?'active':''}" data-dsid="${esc(ds.id)}"><div class="dataset-icon">▦</div><div class="dataset-info"><div class="dataset-title" title="${esc(ds.name)}">${esc(ds.name)}</div><div class="dataset-sub">${ds.images.length} images · ${ds.classes.length} classes</div></div><button class="remove-dataset" data-remove="${esc(ds.id)}" title="Remove from workspace (does not delete files)">×</button></div>`).join('') : '<div class="empty-inline">No folders opened yet.</div>';
    $('datasetList').querySelectorAll('.dataset-item').forEach(el => el.addEventListener('click',async e=>{
      if(e.target.closest('[data-remove]')){
        if (!(await guardUnsaved()))return;
        removeDataset(el.dataset.dsid);return;
      }
      const im=state.images.findIndex(im=>im.datasetId===el.dataset.dsid);
      if(im>=0) await navigate(im);
    }));
    updateSummary();
  }
  function filteredImages() {
    const s=state.search.toLowerCase();
    return state.images.filter(im=>{
      if(s && !`${im.rel} ${im.datasetName}`.toLowerCase().includes(s))return false;
      const reviewed=!!state.reviewed[reviewKey(im)];
      return state.filter==='all'||(state.filter==='pending'&&!reviewed)||(state.filter==='reviewed'&&reviewed);
    });
  }
  function renderQueue() {
    const current=getCurrent();const q=filteredImages();
    $('queueCount').textContent=`${q.length} image${q.length===1?'':'s'}`;
    $('imageList').innerHTML=q.length?q.map(im=>{
      const index=state.images.indexOf(im), reviewed=!!state.reviewed[reviewKey(im)];
      return `<button class="image-item ${current===im?'active':''} ${reviewed?'reviewed':''}" data-index="${index}"><span class="image-indicator">${reviewed?'✓':'▧'}</span><span class="image-details"><span class="image-name" title="${esc(im.rel)}">${esc(im.rel.split('/').pop())}</span><span class="image-path">${esc(im.datasetName)} ${im.rel.includes('/')?'· '+esc(im.rel.split('/').slice(0,-1).join('/')):''}</span></span>${reviewed?'<span class="image-corrected">OK</span>':''}</button>`;
    }).join(''):'<div class="empty-inline">No matching images.</div>';
    $('imageList').querySelectorAll('.image-item').forEach(el=>el.addEventListener('click',()=>navigate(+el.dataset.index)));
    if(current) $('imageList').querySelector('.image-item.active')?.scrollIntoView({block:'nearest'});
    const total=state.images.length,n=state.images.filter(im=>state.reviewed[reviewKey(im)]).length;
    $('progressText').textContent=`${n} / ${total}`;
    $('progressFill').style.width=total?`${100*n/total}%`:'0%';
    $('imagePosition').textContent=current?`${state.active+1} / ${total}`:`0 / ${total}`;
    $('prevBtn').disabled=!current||!state.images.length;
    $('nextBtn').disabled=!current||!state.images.length;
    updateSummary();
  }
  function updateSummary() {
    $('datasetSummary').textContent=state.datasets.length?`${state.datasets.length} dataset${state.datasets.length===1?'':'s'} · ${state.images.length} images`:'No dataset open';
  }
  function releaseImage() {
    if(state.imgURL) URL.revokeObjectURL(state.imgURL);
    state.imgURL=null;state.img=null;
  }
  function clearImage() {
    ++state.loadingToken;releaseImage();state.doc=null;state.selected=-1;state.source=null;
    state.dirty=false;state.undo=[];state.redo=[];state.draft=[];state.drag=null;
    $('currentFile').textContent='Open a dataset to begin';$('currentDataset').textContent='READY TO REVIEW';
    $('dimensionsBadge').textContent='—';$('shapeBadge').textContent='—';
    showEmpty(true);renderInspector();updateButtons();draw();
  }
  async function openImage(index) {
    if(index<0||index>=state.images.length)return;
    const token=++state.loadingToken;
    state.active=index;const im=getCurrent(),ds=datasetFor(im);
    releaseImage();state.doc=null;state.selected=-1;state.dirty=false;state.source=null;state.labelHandle=null;
    state.undo=[];state.redo=[];state.draft=[];state.drag=null;state.zoom=1;state.panX=0;state.panY=0;
    $('currentFile').textContent=im.rel.split('/').pop();$('currentDataset').textContent=ds.name.toUpperCase();
    $('contextHint').textContent='Loading image and its existing annotation file...';
    renderDatasets();renderQueue();renderInspector();updateButtons();
    try {
      const [file,labelHandle]=await Promise.all([im.handle.getFile(),getNestedFile(ds.labelsDir,im.labelRel,false)]);
      const imageURL=URL.createObjectURL(file);
      const image=new Image();
      try { await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('Image could not be decoded.'));image.src=imageURL;}); }
      catch(err){URL.revokeObjectURL(imageURL);throw err;}
      if(token!==state.loadingToken){URL.revokeObjectURL(imageURL);return;}
      let text='',meta=null;
      if(labelHandle){const lf=await labelHandle.getFile();text=await lf.text();meta={lastModified:lf.lastModified,size:lf.size};}
      if(token!==state.loadingToken){URL.revokeObjectURL(imageURL);return;}
      state.img=image;state.imgURL=imageURL;state.labelHandle=labelHandle;
      state.source={text,meta};state.doc=M.parseLabel(text);
      $('dimensionsBadge').textContent=`${image.naturalWidth} × ${image.naturalHeight}`;
      showEmpty(false);updateClassOptions();renderInspector();updateButtons();fitImage();renderQueue();
    } catch(err) {
      if(token!==state.loadingToken)return;
      toast(`Could not read ${im.rel}: ${err.message}`,true);clearImage();
    }
  }
  async function guardUnsaved() {
    if(!state.dirty)return true;
    const choice=confirm('This image has unsaved annotation edits.\n\nOK: Save them before leaving.\nCancel: Stay and keep editing.');
    if(!choice)return false;
    return await saveLabels();
  }
  async function navigate(index) {if(index===state.active)return;if(await guardUnsaved())await openImage(index);}
  async function next(delta=1) {
    if(!state.images.length)return;
    const q=filteredImages();if(!q.length)return;
    const i=q.indexOf(getCurrent());const target=q[(i+delta+q.length)%q.length];
    await navigate(state.images.indexOf(target));
  }
  function updateClassOptions() {
    const ds=datasetFor(getCurrent());const classes=ds?.classes || [];
    const ids=new Set(classes.map((_,i)=>i));
    for(const {a} of annotations()) ids.add(a.classId);
    ids.add(0);
    const vals=[...ids].sort((a,b)=>a-b);
    const curNew=$('newClassSelect').value;
    for(const el of [$('newClassSelect'),$('classSelect')]){
      const prev=el=== $('newClassSelect')?curNew:el.value;
      el.replaceChildren(...vals.map(id=>{const opt=document.createElement('option');opt.value=String(id);opt.textContent=`${id} · ${classes[id]||`Class ${id}`}`;return opt;}));
      if([...el.options].some(x=>x.value===prev))el.value=prev;
    }
  }
  function renderInspector() {
    const shapes=annotations(),selected=selectedAnno();
    $('annoCount').textContent=shapes.length;
    $('objCount').textContent=`${shapes.length} total`;
    $('annotationList').innerHTML=shapes.length ? shapes.map(({a,i},idx)=>
      `<div class="annotation-item ${i===state.selected?'active':''}" data-entry="${i}"><span class="color-swatch" style="background:${colorFor(a.classId)}"></span><div class="annotation-body"><div class="annotation-name">${esc(className(a.classId))}</div><div class="annotation-sub">Object ${idx+1} · Class ${a.classId}</div></div><span class="annotation-type">${shortType(a.kind)}</span></div>`).join(''):'<div class="empty-inline">No annotations in this image.</div>';
    $('annotationList').querySelectorAll('[data-entry]').forEach(el=>el.addEventListener('click',()=>{
      state.selected=+el.dataset.entry;state.tool='select';state.draft=[];syncTools();renderInspector();draw();
    }));
    const bad=state.doc?.entries.filter(a=>a.unsupported).length || 0;
    $('formatAlert').classList.toggle('hidden',!bad);
    $('formatAlert').textContent=bad?`${bad} unrecognized annotation row${bad===1?'':'s'} found. These rows are preserved exactly when saving, but cannot be edited graphically. Check whether this folder contains pose/keypoints or another label format.`:'';
    $('selectionEmpty').classList.toggle('hidden',!!selected);
    $('selectedEditor').classList.toggle('hidden',!selected);
    if(selected){
      updateClassOptions();$('classSelect').value=String(selected.classId);
      $('selectedType').textContent=shortType(selected.kind);
      $('selectedVertexCount').textContent=`${selected.points.length} point${selected.points.length===1?'':'s'}`;
      const pr=(x)=>(100*x).toFixed(2)+'%';
      if(selected.kind==='box') {
        const [[x1,y1],[x2,y2]]=selected.points;
        $('numericInfo').textContent=`Center: ${pr((x1+x2)/2)}, ${pr((y1+y2)/2)}\nSize: ${pr(x2-x1)} × ${pr(y2-y1)}`;
      }else if(selected.kind==='point') $('numericInfo').textContent=`X: ${pr(selected.points[0][0])}\nY: ${pr(selected.points[0][1])}`;
      else $('numericInfo').textContent=`${selected.points.length} editable polygon vertices\nDouble-click an edge to insert a point.`;
    }
    $('shapeBadge').textContent=`${shapes.length} annotation${shapes.length===1?'':'s'}`;
  }
  function updateButtons() {
    const loaded=!!state.doc;
    $('saveBtn').disabled=!loaded||!state.dirty;
    $('reviewBtn').disabled=!loaded;
    $('undoBtn').disabled=!loaded||!state.undo.length;
    $('redoBtn').disabled=!loaded||!state.redo.length;
    $('saveState').innerHTML=state.dirty?'<span>●</span> Unsaved changes':'<span>●</span> All changes saved';
    $('saveState').classList.toggle('dirty',state.dirty);
    if(!loaded){$('contextHint').textContent='Choose a dataset folder to begin reviewing.';return;}
    const im=getCurrent(),label=im?.labelRel||'labels';
    $('contextHint').textContent=`Editing: labels/${label} · Drag handles to correct · Save writes the original .txt`;
  }
  function snapshot() {return JSON.stringify(state.doc);}
  function startEdit(){if(!state.doc)return;state.pendingSnapshot=snapshot();}
  function endEdit(){
    if(!state.pendingSnapshot||!state.doc)return;
    if(state.pendingSnapshot!==snapshot()){
      state.undo.push(state.pendingSnapshot);if(state.undo.length>80)state.undo.shift();
      state.redo=[];state.dirty=true;
    }
    state.pendingSnapshot=null;updateButtons();renderInspector();draw();
  }
  function undo(){
    if(!state.undo.length||!state.doc)return;
    state.redo.push(snapshot());state.doc=JSON.parse(state.undo.pop());state.selected=-1;
    state.dirty=true;updateClassOptions();renderInspector();updateButtons();draw();
  }
  function redo(){
    if(!state.redo.length||!state.doc)return;
    state.undo.push(snapshot());state.doc=JSON.parse(state.redo.pop());state.selected=-1;
    state.dirty=true;updateClassOptions();renderInspector();updateButtons();draw();
  }
  function editSelected(callback) {
    const a=selectedAnno();if(!a)return;
    startEdit();callback(a);a.modified=true;endEdit();
  }
  function deleteSelected(){if(!selectedAnno())return;startEdit();state.doc.entries.splice(state.selected,1);state.selected=-1;endEdit();}
  function duplicateSelected(){
    const a=selectedAnno();if(!a)return;startEdit();
    const b=M.clone(a);b.points=b.points.map(([x,y])=>[clamp(x+0.012),clamp(y+0.012)]);b.modified=true;b.rawLine='';
    state.doc.entries.splice(state.selected+1,0,b);state.selected+=1;endEdit();
  }
  async function backupOriginal(ds,im,text){
    if(!text)return;
    const backupRel=`${im.labelRel}.bak`;
    const folder=await ds.labelsDir.getDirectoryHandle('.labelcheck-backups',{create:true});
    const old=await getNestedFile(folder,backupRel,false);
    if(old)return;
    const file=await getNestedFile(folder,backupRel,true);
    const stream=await file.createWritable();
    try {await stream.write(text);await stream.close();}
    catch(e){try{await stream.abort();}catch{}throw e;}
  }
  async function saveLabels(){
    if(!state.doc)return false;
    if(!state.dirty)return true;
    const problems=M.validateChanged(state.doc);
    if(problems.length){toast(`Cannot save: ${problems[0]}`,true);return false;}
    const im=getCurrent(),ds=datasetFor(im);if(!im||!ds)return false;
    try {
      const target=await getNestedFile(ds.labelsDir,im.labelRel,false);
      const diskText=target?await (await target.getFile()).text():'';
      if(diskText!==state.source.text){
        const overwrite=confirm('This label file was changed outside LabelCheck after you opened it.\n\nPress OK to overwrite the external changes, or Cancel to keep the external file and return to editing.');
        if(!overwrite)return false;
      }
      const result=M.serializeLabel(state.doc);
      if(result===diskText){state.dirty=false;state.undo=[];state.redo=[];updateButtons();toast('There are no file changes to write.');return true;}
      await backupOriginal(ds,im,diskText);
      const fh=target || await getNestedFile(ds.labelsDir,im.labelRel,true);
      const stream=await fh.createWritable();
      try {await stream.write(result);await stream.close();}
      catch(e){try{await stream.abort();}catch{}throw e;}
      state.labelHandle=fh;const after=await fh.getFile();
      state.source={text:result,meta:{lastModified:after.lastModified,size:after.size}};
      state.doc=M.parseLabel(result);state.selected=-1;
      state.dirty=false;state.undo=[];state.redo=[];
      updateClassOptions();renderInspector();updateButtons();draw();toast(`Saved ${im.labelRel} to the original dataset.`);
      return true;
    }catch(err){toast(`Save failed: ${err.message}`,true);return false;}
  }
  async function markReviewed(){
    const im=getCurrent();if(!im)return;
    if(state.dirty&&!(await saveLabels()))return;
    state.reviewed[reviewKey(im)]=Date.now();storeReviews();
    toast(`Reviewed: ${im.rel.split('/').pop()}`);renderQueue();
    const pending=state.images.filter(a=>!state.reviewed[reviewKey(a)]);
    if(pending.length) await openImage(state.images.indexOf(pending[0]));
    else toast('All loaded images reviewed. Well done!');
  }
  function fitImage(){state.zoom=1;state.panX=0;state.panY=0;draw();}
  function calcView(){
    const w=canvas.clientWidth,h=canvas.clientHeight;
    if(!state.img)return {w,h,scale:1,ox:0,oy:0};
    state.fitScale=Math.min((w-64)/state.img.naturalWidth,(h-64)/state.img.naturalHeight);
    const scale=Math.max(0.0001,state.fitScale*state.zoom);
    const ox=(w-state.img.naturalWidth*scale)/2+state.panX,oy=(h-state.img.naturalHeight*scale)/2+state.panY;
    state.originX=ox;state.originY=oy;
    $('zoomLabel').textContent=`${Math.round(state.zoom*100)}%`;
    return {w,h,scale,ox,oy};
  }
  const ptToScreen=(p,v)=>[v.ox+p[0]*state.img.naturalWidth*v.scale,v.oy+p[1]*state.img.naturalHeight*v.scale];
  const screenToPoint=(x,y,v)=>[(x-v.ox)/(state.img.naturalWidth*v.scale),(y-v.oy)/(state.img.naturalHeight*v.scale)];
  function boxCorners(a){const [[x1,y1],[x2,y2]]=a.points;return [[x1,y1],[x2,y1],[x2,y2],[x1,y2]];}
  function drawShape(a,v,selected=false){
    const color=colorFor(a.classId);
    const vertices=a.kind==='box'?boxCorners(a):a.points;
    const points=vertices.map(p=>ptToScreen(p,v));
    ctx.save();ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineJoin='round';ctx.lineCap='round';ctx.lineWidth=selected?2.4:1.8;
    if(a.kind==='point'){
      const [x,y]=points[0];
      ctx.beginPath();ctx.arc(x,y,selected?9:7,0,Math.PI*2);ctx.fillStyle='#0b1119d9';ctx.fill();ctx.stroke();
      ctx.beginPath();ctx.moveTo(x-12,y);ctx.lineTo(x+12,y);ctx.moveTo(x,y-12);ctx.lineTo(x,y+12);ctx.stroke();
      ctx.beginPath();ctx.arc(x,y,2.5,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
    }else if(points.length){
      ctx.beginPath();points.forEach(([x,y],i)=>i===0?ctx.moveTo(x,y):ctx.lineTo(x,y));ctx.closePath();
      ctx.fillStyle=color.replace(')', ' / 0.13)');
      // Canvas accepts modern hsla color syntax; use explicit alpha safely.
      ctx.fillStyle=color.slice(0,-1)+' / 0.14)';ctx.fill();ctx.stroke();
    }
    if(selected){
      points.forEach(([x,y])=>{ctx.fillStyle='#eaf1ff';ctx.fillRect(x-4.4,y-4.4,8.8,8.8);ctx.strokeStyle=color;ctx.lineWidth=1.4;ctx.strokeRect(x-4.4,y-4.4,8.8,8.8);});
    }
    if(a.kind!=='point' && points.length){
      const minX=Math.min(...points.map(p=>p[0])),minY=Math.min(...points.map(p=>p[1]));
      ctx.font='700 11px system-ui,sans-serif';const label=`${a.classId}: ${className(a.classId)}`;
      const labelW=Math.min(ctx.measureText(label).width+13,240);
      const lx=Math.max(4,Math.min(v.w-labelW-3,minX)),ly=Math.max(4,minY-23);
      ctx.fillStyle='#101824ed';ctx.fillRect(lx,ly,labelW,19);ctx.fillStyle=color;ctx.fillText(label,lx+6,ly+13,Math.max(0,labelW-10));
    }
    ctx.restore();
  }
  function resizeCanvas(){
    const w=Math.max(1,canvas.clientWidth),h=Math.max(1,canvas.clientHeight);
    const dpr=Math.min(3,window.devicePixelRatio||1);
    if(canvas.width!==Math.floor(w*dpr)||canvas.height!==Math.floor(h*dpr)){
      canvas.width=Math.floor(w*dpr);canvas.height=Math.floor(h*dpr);
    }
    ctx.setTransform(dpr,0,0,dpr,0,0);
    draw();
  }
  function draw(){
    const dpr=Math.min(3,window.devicePixelRatio||1),w=canvas.clientWidth,h=canvas.clientHeight;
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
    if(!state.img)return;
    const v=calcView();
    ctx.save();ctx.shadowColor='#000b';ctx.shadowBlur=30;ctx.shadowOffsetY=12;
    ctx.drawImage(state.img,v.ox,v.oy,state.img.naturalWidth*v.scale,state.img.naturalHeight*v.scale);ctx.restore();
    if(state.showOverlay){
      for(const {a,i} of annotations()) if(i!==state.selected)drawShape(a,v);
      if(selectedAnno())drawShape(selectedAnno(),v,true);
      if(state.draft.length){
        ctx.save();ctx.strokeStyle='#d7e1ff';ctx.lineWidth=2;ctx.setLineDash([7,5]);ctx.beginPath();
        const pts=state.draft.map(p=>ptToScreen(p,v));
        pts.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));
        if(state.tool==='box'&&pts.length>=2){const [a,b]=pts;ctx.rect(a[0],a[1],b[0]-a[0],b[1]-a[1]);}
        ctx.stroke();ctx.setLineDash([]);
        for(const [x,y] of pts){ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.fillStyle='#f4f5ff';ctx.fill();}
        ctx.restore();
      }
    }
  }
  function canvasPos(e){const r=canvas.getBoundingClientRect();return [e.clientX-r.left,e.clientY-r.top];}
  function distanceToSegment(p,a,b){const dx=b[0]-a[0],dy=b[1]-a[1];if(dx===0&&dy===0)return Math.hypot(p[0]-a[0],p[1]-a[1]);const t=clamp(((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy));return Math.hypot(p[0]-(a[0]+t*dx),p[1]-(a[1]+t*dy));}
  function pointInPolygon(p,points){let inside=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[i],b=points[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside;}
  function hitTest(x,y,v){
    const a=selectedAnno();
    if(a){const pts=(a.kind==='box'?boxCorners(a):a.points).map(p=>ptToScreen(p,v));
      for(let i=0;i<pts.length;i++)if(Math.hypot(x-pts[i][0],y-pts[i][1])<=10)return {type:'vertex',entry:state.selected,idx:i};
    }
    for(const {a,i} of annotations().reverse()){
      const pts=(a.kind==='box'?boxCorners(a):a.points).map(p=>ptToScreen(p,v));
      if(a.kind==='point'&&Math.hypot(x-pts[0][0],y-pts[0][1])<15)return {type:'shape',entry:i};
      if(a.kind==='box'){
        const xx=pts.map(p=>p[0]),yy=pts.map(p=>p[1]);
        if(x>=Math.min(...xx)-4&&x<=Math.max(...xx)+4&&y>=Math.min(...yy)-4&&y<=Math.max(...yy)+4)return {type:'shape',entry:i};
      }else if(a.kind==='polygon'){
        if(pointInPolygon([x,y],pts))return {type:'shape',entry:i};
        if(pts.some((pt,k)=>distanceToSegment([x,y],pt,pts[(k+1)%pts.length])<8))return {type:'shape',entry:i};
      }
    }
    return null;
  }
  function cursorFor(e){
    if(!state.img)return;
    if(state.tool==='box')canvas.style.cursor='crosshair';
    else if(state.tool==='polygon'||state.tool==='point')canvas.style.cursor='crosshair';
    else if(e&&state.selected>=0){const [x,y]=canvasPos(e),hit=hitTest(x,y,calcView());canvas.style.cursor=hit?(hit.type==='vertex'?'move':'grab'):'default';}
    else canvas.style.cursor='default';
  }
  function setTool(tool){
    if(state.draft.length && tool!==state.tool){state.draft=[];draw();}
    state.tool=tool;syncTools();cursorFor();
    const hints={select:'Click an object to select; drag points or shape to fix.',box:'Click and drag to create a bounding box.',polygon:'Click vertices, then press Enter or double click to finish.',point:'Click on the image to add an annotation point.'};
    $('canvasHint').textContent=hints[tool]||'';$('canvasHint').classList.toggle('hidden',!state.img);
    if(state.img)setTimeout(()=>$('canvasHint').classList.add('hidden'),3000);
  }
  function syncTools(){document.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===state.tool));}
  function addShape(kind,points){
    if(!state.doc)return;
    const classId=Number($('newClassSelect').value||0);
    startEdit();state.doc.entries.push({kind,classId,points,rawLine:'',modified:true});state.selected=state.doc.entries.length-1;endEdit();
    setTool('select');
  }
  function finishPolygon(){
    if(state.draft.length<3){toast('A polygon needs at least 3 points.',true);return;}
    const pts=state.draft.slice();
    while(pts.length>=4&&Math.hypot(pts.at(-1)[0]-pts.at(-2)[0],pts.at(-1)[1]-pts.at(-2)[1])<0.0005)pts.pop();
    if(pts.length<3){toast('A polygon needs 3 distinct points.',true);return;}
    state.draft=[];addShape('polygon',pts);draw();
  }
  function onPointerDown(e){
    if(!state.img||!state.doc)return;
    if(e.button!==0 && e.button!==1)return;
    e.preventDefault();canvas.focus({preventScroll:true});canvas.setPointerCapture(e.pointerId);
    const [x,y]=canvasPos(e),v=calcView(),pt=screenToPoint(x,y,v);
    if(e.button===1){state.drag={type:'pan',start:[x,y],initial:[state.panX,state.panY]};return;}
    if(state.tool==='point'){
      if(pt.some(n=>n<0||n>1))return;addShape('point',[[clamp(pt[0]),clamp(pt[1])]]);return;
    }
    if(state.tool==='polygon'){
      if(pt.some(n=>n<0||n>1))return;
      const now=performance.now(),last=state.lastPolygonClick;
      state.lastPolygonClick={time:now,x,y};
      if(last && now-last.time<360 && Math.hypot(x-last.x,y-last.y)<9)return; // second tap in a double-click
      state.draft.push([clamp(pt[0]),clamp(pt[1])]);draw();return;
    }
    if(state.tool==='box'){
      if(pt.some(n=>n<0||n>1))return;
      state.draft=[[clamp(pt[0]),clamp(pt[1])],[clamp(pt[0]),clamp(pt[1])]];
      state.drag={type:'newbox',pointerId:e.pointerId};draw();return;
    }
    if(state.tool==='select'){
      const hit=hitTest(x,y,v);
      if(hit){
        if(hit.type==='vertex' && e.altKey){
          const a=state.doc.entries[hit.entry];
          if(a.kind==='polygon'&&a.points.length>3){state.selected=hit.entry;editSelected(b=>b.points.splice(hit.idx,1));}
          else toast('Polygon needs at least 3 vertices.',true);
          return;
        }
        if(state.selected!==hit.entry){state.selected=hit.entry;renderInspector();draw();}
        state.drag={type:hit.type,entry:hit.entry,idx:hit.idx,start:[x,y],ptStart:pt,points:M.clone(state.doc.entries[hit.entry].points)};
        startEdit();return;
      }
      state.selected=-1;renderInspector();draw();
      state.drag={type:'pan',start:[x,y],initial:[state.panX,state.panY]};
    }
  }
  function onPointerMove(e){
    if(!state.img||!state.doc)return;
    if(!state.drag){cursorFor(e);return;}
    const [x,y]=canvasPos(e),d=state.drag,v=calcView();
    if(d.type==='pan'){
      state.panX=d.initial[0]+(x-d.start[0]);state.panY=d.initial[1]+(y-d.start[1]);draw();return;
    }
    const pt=screenToPoint(x,y,v);
    if(d.type==='newbox') {state.draft[1]=pt.map(clamp);draw();return;}
    const a=state.doc.entries[d.entry];if(!a)return;
    if(d.type==='shape'){
      const dx=pt[0]-d.ptStart[0],dy=pt[1]-d.ptStart[1];
      const minX=Math.min(...d.points.map(p=>p[0])),maxX=Math.max(...d.points.map(p=>p[0]));
      const minY=Math.min(...d.points.map(p=>p[1])),maxY=Math.max(...d.points.map(p=>p[1]));
      const ddx=Math.max(-minX,Math.min(1-maxX,dx)),ddy=Math.max(-minY,Math.min(1-maxY,dy));
      a.points=d.points.map(p=>[p[0]+ddx,p[1]+ddy]);
    } else if(d.type==='vertex'){
      if(a.kind==='box'){
        const points=M.clone(d.points),corner=d.idx;
        if(corner===0){points[0]=pt.map(clamp);}
        if(corner===1){points[1][0]=clamp(pt[0]);points[0][1]=clamp(pt[1]);}
        if(corner===2){points[1]=pt.map(clamp);}
        if(corner===3){points[0][0]=clamp(pt[0]);points[1][1]=clamp(pt[1]);}
        a.points=points;
      } else a.points[d.idx]=pt.map(clamp);
    }
    a.modified=true;draw();
  }
  function onPointerUp(e){
    const d=state.drag;state.drag=null;
    if(!d)return;
    if(d.type==='newbox'){
      const [[x1,y1],[x2,y2]]=state.draft;state.draft=[];
      if(Math.abs(x1-x2)<0.002 || Math.abs(y1-y2)<0.002){toast('Drag to create a box with some width and height.',true);draw();return;}
      addShape('box',[[Math.min(x1,x2),Math.min(y1,y2)],[Math.max(x1,x2),Math.max(y1,y2)]]);
    } else if(d.type==='shape'||d.type==='vertex'){
      if(state.doc){M.normalizeBox(state.doc.entries[d.entry]);endEdit();}
    }
    cursorFor(e);draw();
  }
  function onDoubleClick(e){
    if(!state.img||!state.doc)return;
    if(state.tool==='polygon'){if(state.draft.length>=3)finishPolygon();return;}
    if(state.tool!=='select')return;
    const a=selectedAnno();if(!a||a.kind!=='polygon')return;
    const [x,y]=canvasPos(e),v=calcView(),verts=a.points.map(p=>ptToScreen(p,v));
    let best=Infinity,idx=-1;
    for(let i=0;i<verts.length;i++){const distance=distanceToSegment([x,y],verts[i],verts[(i+1)%verts.length]);if(distance<best){best=distance;idx=i;}}
    if(best<=13){const p=screenToPoint(x,y,v).map(clamp);editSelected(a=>a.points.splice(idx+1,0,p));}
  }
  function onWheel(e){
    if(!state.img)return;e.preventDefault();
    const [mx,my]=canvasPos(e);const old=calcView();
    const imageCoord=screenToPoint(mx,my,old);
    const factor=e.deltaY<0?1.13:1/1.13;
    state.zoom=Math.max(.12,Math.min(18,state.zoom*factor));
    const next=calcView(),nextPos=ptToScreen(imageCoord,next);
    state.panX+=mx-nextPos[0];state.panY+=my-nextPos[1];draw();
  }
  function onKey(e){
    const tag=document.activeElement?.tagName;
    if(['INPUT','SELECT','TEXTAREA'].includes(tag)||$('helpDialog').open)return;
    const mod=e.ctrlKey||e.metaKey,key=e.key.toLowerCase();
    if(mod&&key==='s'){e.preventDefault();saveLabels();return;}
    if(mod&&key==='z'){e.preventDefault();e.shiftKey?redo():undo();return;}
    if(mod&&key==='y'){e.preventDefault();redo();return;}
    if(mod||e.altKey)return;
    if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();deleteSelected();return;}
    if(e.key==='Escape'){state.draft=[];state.drag=null;state.pendingSnapshot=null;draw();return;}
    if(e.key==='Enter'&&state.tool==='polygon'){e.preventDefault();finishPolygon();return;}
    if(key==='j'){next(-1);return;}if(key==='k'){next(1);return;}
    if(key==='f'){fitImage();return;}if(key==='o'){state.showOverlay=!state.showOverlay;draw();return;}
    if(key==='v')setTool('select');if(key==='b')setTool('box');if(key==='g')setTool('polygon');if(key==='p')setTool('point');
  }
  function bindEvents(){
    ['addFolderTop','addFolderSide','addFolderEmpty'].forEach(id=>$(id).addEventListener('click',addDataset));
    $('helpBtn').addEventListener('click',()=>$('helpDialog').showModal());
    $('prevBtn').addEventListener('click',()=>next(-1));$('nextBtn').addEventListener('click',()=>next(1));
    $('saveBtn').addEventListener('click',saveLabels);$('reviewBtn').addEventListener('click',markReviewed);
    $('undoBtn').addEventListener('click',undo);$('redoBtn').addEventListener('click',redo);
    $('fitBtn').addEventListener('click',fitImage);$('overlayBtn').addEventListener('click',()=>{state.showOverlay=!state.showOverlay;draw();});
    $('duplicateBtn').addEventListener('click',duplicateSelected);$('deleteBtn').addEventListener('click',deleteSelected);
    $('classSelect').addEventListener('change',e=>editSelected(a=>a.classId=Number(e.target.value)));
    $('searchInput').addEventListener('input',e=>{state.search=e.target.value;renderQueue();});
    document.querySelectorAll('[data-tool]').forEach(b=>b.addEventListener('click',()=>setTool(b.dataset.tool)));
    document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{
      state.filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('active',x===b));renderQueue();
    }));
    canvas.addEventListener('pointerdown',onPointerDown);canvas.addEventListener('pointermove',onPointerMove);
    canvas.addEventListener('pointerup',onPointerUp);canvas.addEventListener('pointercancel',onPointerUp);
    canvas.addEventListener('dblclick',onDoubleClick);canvas.addEventListener('wheel',onWheel,{passive:false});
    canvas.addEventListener('contextmenu',e=>e.preventDefault());
    window.addEventListener('keydown',onKey);
    window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue='';}});
    new ResizeObserver(resizeCanvas).observe($('stageWrap'));
    const stage=$('stageWrap');
    stage.addEventListener('dragover',e=>{if([...e.dataTransfer.items].some(i=>i.kind==='file'))e.preventDefault();});
    stage.addEventListener('drop',async e=>{
      e.preventDefault();
      try {
        for(const item of e.dataTransfer.items){
          if(typeof item.getAsFileSystemHandle!=='function')continue;
          const handle=await item.getAsFileSystemHandle();
          if(handle?.kind==='directory'){await registerDataset(handle);return;}
        }
        toast('Use “Add dataset folder” and select the main folder containing images/ and labels/.',true);
      }catch(err){toast(`Could not open dropped folder: ${err.message}`,true);}
    });
  }
  function init(){
    bindEvents();renderDatasets();renderQueue();renderInspector();updateButtons();resizeCanvas();showEmpty(true);
    if(typeof window.showDirectoryPicker!=='function'){
      $('emptyState').querySelector('p').insertAdjacentHTML('beforeend','<br><strong style="color:#ffa9ad">Use Chrome or Edge for editable local folder access.</strong>');
    }
  }
  init();
  // Small read-only debug surface for automated smoke tests; no file handles are exposed.
  window.LabelCheckDebug = Object.freeze({getState:()=>({datasets:state.datasets.length,images:state.images.length,loaded:!!state.doc,dirty:state.dirty,selected:state.selected})});
})();
