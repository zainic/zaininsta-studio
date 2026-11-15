const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { view: 'overview', filter: 'all', accounts: [], posts: [], media: [], downloads: [], selectedDownloads: new Set(), clearingDownloads: false, stats: {}, config: {}, toastTimer: null };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const formatDate = value => { try { return new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric', year:'numeric' }).format(new Date(value)); } catch { return '—'; } };
const formatTime = value => { try { return new Intl.DateTimeFormat(undefined, { hour:'numeric', minute:'2-digit' }).format(new Date(value)); } catch { return '—'; } };
const formatShortDate = value => { try { return new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric' }).format(new Date(value)); } catch { return '—'; } };
const filesize = n => n > 1024*1024 ? `${(n/1048576).toFixed(1)} MB` : `${(n/1024).toFixed(0)} KB`;
const capitalize = value => String(value || '').replace(/_/g,' ').replace(/^\w/,c=>c.toUpperCase());
const titleFromPost = p => String(p.caption || '').trim().split('\n')[0].slice(0, 70) || (p.kind === 'reel' ? 'Untitled Reel' : 'Untitled image post');
const niceStatus = s => ({ needs_review:'Needs review', processing:'Processing', publishing:'Publishing' }[s] || capitalize(s));
const urlIsImage = u => /\.(jpg|jpeg|png)(?:\?.*)?$/i.test(u || '');
function toast(message, error=false) {
  const el = $('#toast'); el.textContent = message; el.classList.toggle('error',error); el.classList.remove('hidden');
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(()=>el.classList.add('hidden'), 5000);
}
async function api(url, method='GET', payload, options={}) {
  const headers = payload === undefined || options.raw ? {} : { 'Content-Type':'application/json' };
  if (options.headers) Object.assign(headers, options.headers);
  const res = await fetch(url, { method, credentials:'same-origin', headers, body:payload === undefined ? undefined : options.raw ? payload : JSON.stringify(payload) });
  let data = {}; try { data = await res.json(); } catch { /* response might be empty */ }
  if (!res.ok) {
    if (res.status === 401 && url !== '/api/login') showLogin();
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}
function showLogin() { $('#login-screen').classList.remove('hidden'); $('#app').classList.add('hidden'); $('#admin-password').value = ''; }
function showApp() { $('#login-screen').classList.add('hidden'); $('#app').classList.remove('hidden'); }
function jump(view) {
  if (!$('#view-' + view)) view = 'overview';
  state.view = view;
  $$('.view').forEach(el => el.classList.toggle('hidden', el.id !== 'view-'+view));
  $$('[data-view]').forEach(b => b.classList.toggle('active', b.classList.contains('nav-item') && b.dataset.view === view));
  $('#breadcrumb-current').textContent = ({ overview:'Overview', compose:'Create post', calendar:'Content planner', library:'Media library', downloader:'Video downloader', settings:'Connections' }[view] || view);
  $('#sidebar').classList.remove('open');
  const search = new URLSearchParams(location.search); search.set('view', view); search.delete('oauth');
  history.replaceState({},'',location.pathname + '?' + search.toString());
  if (view==='compose') updatePreview();
  if (view==='settings') renderSettings();
  if (view==='calendar') renderPlanner();
  if (view==='library') renderLibrary();
  if (view==='downloader') renderDownloads();
  scrollTo({ top:0, behavior:'instant' });
}
async function loadAll() {
  const [accounts, posts, media, downloads, dashboard, config] = await Promise.all([
    api('/api/accounts'), api('/api/posts'), api('/api/media'), api('/api/downloads'), api('/api/dashboard'), api('/api/config')
  ]);
  state.accounts = accounts.accounts; state.posts = posts.posts; state.media = media.media;
  state.downloads = downloads.downloads; state.stats = dashboard; state.config = config;
  $('#account-indicator').innerHTML = state.accounts.length
    ? `<span class="indicator-dot connected"></span> ${esc(state.accounts.length === 1 ? '@'+state.accounts[0].username : state.accounts.length+' accounts')}`
    : '<span class="indicator-dot"></span> Not connected';
  renderOverview(); renderPlanner(); renderLibrary(); renderDownloads(); renderSettings(); updateAccountSelect();
}
function thumb(p) {
  if (p.kind === 'image' && p.mediaUrl) return `<span class="item-thumb"><img src="${esc(p.mediaUrl)}" alt="" loading="lazy"></span>`;
  return `<span class="item-thumb">${icon(p.kind==='reel' ? 'download' : 'image')}</span>`;
}
function renderOverview() {
  const s = state.stats;
  const cards = [
    {label:'Posts scheduled',value:s.scheduled||0,note:'Ready for their moment',icon:'calendar',highlight:true},
    {label:'Published posts',value:s.published||0,note:'Out in the world',icon:'check'},
    {label:'Connected accounts',value:s.accounts||0,note:'Your creative channels',icon:'grid'},
    {label:'Need attention',value:s.failed||0,note:'Posts to review',icon:'alert'}
  ];
  $('#stats-grid').innerHTML = cards.map(c=>`<div class="stat-card ${c.highlight?'highlight':''}"><div class="stat-top"><span class="stat-kicker">${c.label}</span><span class="stat-icon">${icon(c.icon)}</span></div><span class="stat-value">${c.value}</span><div class="stat-note">${c.note}</div></div>`).join('');
  const dates = Array.from({length:7},(_,i)=>{ const d = new Date(); d.setHours(12,0,0,0); d.setDate(d.getDate()-6+i); return d; });
  const published = state.posts.filter(p=>p.status==='published');
  const points = dates.map(d => ({ day:d.toLocaleDateString(undefined,{weekday:'short'}), count:published.filter(p=>new Date(p.scheduledAt).toDateString()===d.toDateString()).length }));
  const ceiling = Math.max(3,...points.map(p=>p.count));
  $('#activity-chart').innerHTML = `<div class="bar-plot">${points.map((p,i)=>{
    const h = `${Math.max(4,p.count/ceiling*88)}%`;
    return `<div class="bar-col"><span class="bar-num" style="--bar-h:${h}">${p.count}</span><span class="bar ${i===6?'active':''}" style="height:${h}"></span><span class="bar-label">${p.day}</span></div>`;
  }).join('')}</div>`;
  const upcoming = s.upcoming || [];
  $('#up-next').innerHTML = upcoming.length ? upcoming.map(p => `<div class="queue-item">${thumb(p)}<div class="item-detail"><strong>${esc(titleFromPost(p))}</strong><small>@${esc(p.username || 'instagram')} · ${p.kind==='reel'?'Reel':'Image'}</small></div><div class="queue-date">${formatShortDate(p.scheduledAt)}<br>${formatTime(p.scheduledAt)}</div></div>`).join('')
    : `<div class="empty-mini">${icon('calendar')}<strong>Nothing in the queue. Yet.</strong><span>Your next great post could go here.</span><button data-view="compose">Schedule your first post ↗</button></div>`;
  $('#recent-activity').innerHTML = tablePosts(s.recent || [], false, 6);
}
function tablePosts(posts, actions=false, max=200) {
  if (!posts.length) return `<div class="empty-table"><strong>No posts here yet.</strong>Once you create something, you'll see it here.</div>`;
  return `<div class="table-scroll"><table class="data-table"><thead><tr><th>POST</th><th>ACCOUNT</th><th>DATE & TIME</th><th>STATUS</th>${actions?'<th>ACTIONS</th>':''}</tr></thead><tbody>${posts.slice(0,max).map(p => `<tr><td><div class="table-post-cell">${thumb(p)}<div><span class="post-title">${esc(titleFromPost(p))}</span><span class="post-sub">${p.kind==='reel'?'Reel / video':'Image post'}</span></div></div></td><td>@${esc(p.username || 'instagram')}</td><td>${formatDate(p.scheduledAt)}<span class="post-sub">${formatTime(p.scheduledAt)}</span></td><td><span class="status-pill ${esc(p.status)}" title="${esc(p.lastError || '')}">${esc(niceStatus(p.status))}</span>${p.lastError ? `<span class="post-sub" title="${esc(p.lastError)}">${esc(p.lastError.slice(0,44))}${p.lastError.length>44?'…':''}</span>` : ''}</td>${actions ? `<td><div class="table-actions">${p.status==='scheduled'?`<button class="mini-action danger" data-cancel="${p.id}">Cancel</button>`:''}${p.status==='failed'?`<button class="mini-action" data-retry="${p.id}">Retry</button>`:''}${p.permalink?`<a class="mini-action" href="${esc(p.permalink)}" target="_blank" rel="noreferrer">View ↗</a>`:''}${p.status==='needs_review'?'<span class="post-sub">Check Instagram manually</span>':''}</div></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}
function renderPlanner() {
  const posts = state.filter === 'all' ? state.posts : state.filter === 'failed' ? state.posts.filter(p=>['failed','needs_review'].includes(p.status)) : state.posts.filter(p=>p.status===state.filter);
  $('#planner-list').innerHTML = tablePosts(posts, true);
  $$('.filter-tab').forEach(b=>b.classList.toggle('active',b.dataset.filter===state.filter));
}
function renderLibrary() {
  $('#media-count').textContent=state.media.length;
  $('#media-list').innerHTML = state.media.length ? state.media.map(m=>`<div class="media-card"><div class="media-visual">${m.mime==='image/jpeg'?`<img src="${esc(m.url)}" alt="${esc(m.name)}" loading="lazy">`:`<video src="${esc(m.url)}" muted preload="metadata" playsinline></video>`}</div><div class="media-card-body"><strong title="${esc(m.name)}">${esc(m.name)}</strong><small>${filesize(m.size)} · ${formatShortDate(m.createdAt)}</small><div class="media-card-actions"><button data-copy="${esc(m.url)}">${icon('copy')} Copy URL</button><button data-use="${esc(m.url)}">Use in post</button><button data-delete-media="${m.id}" title="Delete file" aria-label="Delete file">${icon('trash')}</button></div></div></div>`).join('') : '<div class="empty-library">Your media library is empty. Upload a JPEG, MP4, or MOV to get started.</div>';
}
function clearableDownload(download) { return ['ready','failed'].includes(download.status); }
function updateDownloadSelection() {
  const eligible = state.downloads.filter(clearableDownload);
  const selected = state.selectedDownloads.size;
  const all = $('#select-all-downloads');
  if (all) {
    all.checked = eligible.length > 0 && selected === eligible.length;
    all.indeterminate = selected > 0 && selected < eligible.length;
    all.disabled = state.clearingDownloads || eligible.length === 0;
  }
  $$('[data-select-download]').forEach(input => {
    input.checked = state.selectedDownloads.has(input.dataset.selectDownload);
    input.closest('tr').classList.toggle('download-selected', input.checked);
  });
  $('#downloads-selection-count').textContent = `${selected} selected`;
  const button = $('#clear-downloads');
  button.disabled = state.clearingDownloads || selected === 0;
  button.innerHTML = `${icon('trash')} ${state.clearingDownloads ? 'Clearing...' : 'Clear selected'}`;
}
function renderDownloads() {
  const downloads = state.downloads;
  const eligible = new Set(downloads.filter(clearableDownload).map(d => d.id));
  for (const id of state.selectedDownloads) if (!eligible.has(id)) state.selectedDownloads.delete(id);
  $('#downloads-list').innerHTML = downloads.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th class="download-select-cell"><input type="checkbox" id="select-all-downloads" aria-label="Select all finished downloads" /></th><th>INSTAGRAM LINK</th><th>ADDED</th><th>STATUS</th><th>METHOD</th><th>FILE</th></tr></thead><tbody>${downloads.map(d=>`<tr><td class="download-select-cell"><input type="checkbox" data-select-download="${esc(d.id)}" aria-label="Select download ${esc(d.sourceUrl)}" ${state.selectedDownloads.has(d.id)?'checked':''} ${state.clearingDownloads || !clearableDownload(d)?'disabled':''} /></td><td><div class="download-url-cell" title="${esc(d.sourceUrl)}">${esc(d.sourceUrl)}</div></td><td>${formatShortDate(d.createdAt)}<span class="post-sub">${formatTime(d.createdAt)}</span></td><td><span class="status-pill ${d.status==='ready'?'published':d.status==='failed'?'failed':d.status==='deleted'?'deleted':'processing'}">${esc(capitalize(d.status))}</span>${d.status==='deleted' && d.updatedAt?`<span class="post-sub" title="Deletion time">${formatDate(d.updatedAt)} ${formatTime(d.updatedAt)}</span>`:''}${d.lastError?`<span class="post-sub download-error" title="${esc(d.lastError)}">${esc(d.lastError)}</span>`:''}</td><td><span class="post-sub">${esc(d.sourceMethod==='meta'?'Meta API':d.sourceMethod==='yt-dlp'?'Public extractor':'\u2014')}</span></td><td>${d.status==='ready'?`<a class="mini-action" href="/api/downloads/${esc(d.id)}/file">${icon('download')} Download</a>`:d.status==='deleted'?'<span class="post-sub">File deleted</span>':'\u2014'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-table"><strong>No downloads yet.</strong>Your downloaded videos will show up here.</div>';
  updateDownloadSelection();
}
async function clearSelectedDownloads() {
  if (state.clearingDownloads) return;
  const ids = state.downloads.filter(d => clearableDownload(d) && state.selectedDownloads.has(d.id)).map(d => d.id);
  if (!ids.length || !confirm(`Clear ${ids.length} selected download${ids.length === 1 ? '' : 's'}? Saved video files will be permanently deleted and their download links will stop working. History entries will remain with a Deleted status.`)) return;
  state.clearingDownloads = true;
  renderDownloads();
  let cleared = 0;
  const errors = [];
  try {
    for (const id of ids) {
      try {
        const result = await api('/api/downloads/' + id, 'DELETE');
        state.selectedDownloads.delete(id);
        state.downloads = state.downloads.map(d => d.id === id ? { ...d, status: 'deleted', filename: null, updatedAt: result.updatedAt } : d);
        cleared++;
      } catch (error) { errors.push(error.message); }
    }
    let refreshError = '';
    try { state.downloads = (await api('/api/downloads')).downloads; }
    catch { refreshError = ' Refresh history to load the latest list.'; }
    const message = `${cleared} download${cleared === 1 ? '' : 's'} cleared.${errors.length ? ` Could not clear ${errors.length}: ${errors[0]}` : ''}${refreshError}`;
    toast(message, errors.length > 0 || !!refreshError);
  } finally {
    state.clearingDownloads = false;
    renderDownloads();
  }
}
function renderSettings() {
  $('#connect-btn').classList.toggle('hidden',!state.config.oauthConfigured);
  $('#account-list').innerHTML = state.accounts.length ? state.accounts.map(a=>`<div class="account-row"><div class="account-avatar">${esc(a.username.slice(0,1).toUpperCase())}</div><div><strong>@${esc(a.username)}</strong><small>${esc(a.accountType)} · ${a.authType==='unified'?'Unified Login':'Instagram Login'} · ${a.tokenExpiresAt?'Expires '+formatDate(a.tokenExpiresAt):'No expiration reported'}</small></div><button class="mini-action danger" data-disconnect="${esc(a.id)}">Disconnect</button></div>`).join('') : `<div class="empty-mini">${icon('link')}<strong>No Instagram accounts connected</strong><span>${state.config.oauthConfigured?'Use Connect Instagram above.':'Add Meta credentials in .env first.'}</span></div>`;
  const checks = [
    {text:state.config.oauthMode==='unified'?'Meta Unified Login configured':'Meta Instagram API credentials',ok:state.config.oauthConfigured},
    {text:'Public HTTPS media URL',ok:state.config.publicMediaConfigured},
    {text:'Instagram account connected',ok:state.accounts.length>0}
  ];
  $('#setup-list').innerHTML = checks.map(c=>`<div class="setup-check"><span class="check-circle ${c.ok?'good':''}">${icon(c.ok?'check':'clock')}</span>${c.text}</div>`).join('');
}
function updateAccountSelect() {
  const select = $('#post-account'); const selected = select.value;
  select.innerHTML = `<option value="">Choose an account</option>` + state.accounts.map(a=>`<option value="${esc(a.id)}">@${esc(a.username)} (${esc(a.accountType)})</option>`).join('');
  if (state.accounts.some(a=>a.id===selected)) select.value=selected;
  else if (state.accounts.length===1) select.value=state.accounts[0].id;
  updatePreview();
}
function updatePreview() {
  const selected = state.accounts.find(a=>a.id===$('#post-account').value);
  const username = selected?.username || 'your_account';
  $('#preview-username').textContent=username; $('#preview-account-caption').textContent=username;
  $('#preview-caption').textContent=$('#post-caption').value || 'Your story starts here...';
  $('#caption-count').textContent=`${[...$('#post-caption').value].length.toLocaleString()} / 2,200`;
  const mediaUrl = $('#post-media').value.trim();
  const kind = $('input[name="post-kind"]:checked').value;
  $('#preview-media').innerHTML = /^https:\/\//.test(mediaUrl)
    ? kind==='image'?`<img src="${esc(mediaUrl)}" alt="Post preview" />`:`<video src="${esc(mediaUrl)}" muted controls playsinline preload="metadata"></video>`
    : `${icon('image')}<span>Your media will appear here</span>`;
}
function localDateValue(d) { const date = new Date(d.getTime()-d.getTimezoneOffset()*60000);return date.toISOString().slice(0,16); }
async function uploadFile(file, useInCompose=false) {
  if (!file) return;
  const supported = ['image/jpeg','video/mp4','video/quicktime'];
  if (!supported.includes(file.type)) return toast('Only JPEG, MP4 and MOV files are supported.',true);
  if (file.size>250*1024*1024) return toast('Maximum upload size is 250 MB.',true);
  toast(`Uploading ${file.name}…`);
  try {
    const response = await api('/api/upload','PUT',file,{ raw:true,headers:{ 'Content-Type':file.type, 'X-Filename':encodeURIComponent(file.name).slice(0,150) } });
    state.media.unshift({ ...response.media, createdAt:new Date().toISOString() });
    renderLibrary();
    if (useInCompose) { $('#post-media').value=response.media.url; $('input[name="post-kind"][value="'+(file.type==='image/jpeg'?'image':'reel')+'"]').checked=true; updatePreview(); }
    toast('File uploaded. It is ready to use in a post.');
    if (!state.config.publicMediaConfigured) toast('File uploaded, but configure a public HTTPS URL before publishing.',true);
  } catch (e) { toast(e.message,true); }
}
function showPicker() {
  const el = $('#library-picker');
  if (!el.classList.contains('hidden')) return el.classList.add('hidden');
  el.innerHTML = state.media.length ? state.media.map(m=>`<button class="picker-item" data-picker-url="${esc(m.url)}" data-picker-type="${m.mime==='image/jpeg'?'image':'reel'}"><span class="item-thumb">${icon(m.mime==='image/jpeg'?'image':'download')}</span><span>${esc(m.name)}</span></button>`).join('') : '<p class="field-helper">No uploads yet. Use Upload a file to add one.</p>';
  el.classList.remove('hidden');
}
async function refreshPart(which) {
  try {
    if (which==='posts') { state.posts=(await api('/api/posts')).posts;state.stats=await api('/api/dashboard');renderPlanner();renderOverview(); }
    if (which==='downloads') { state.downloads=(await api('/api/downloads')).downloads;renderDownloads(); }
  } catch(e) { toast(e.message,true); }
}
function bindEvents() {
  $('#login-form').addEventListener('submit',async e=>{
    e.preventDefault(); const btn=$('#login-submit'); btn.disabled=true;
    try { await api('/api/login','POST',{ password:$('#admin-password').value }); showApp();await loadAll();jump(new URLSearchParams(location.search).get('view')||'overview'); }
    catch(err) { toast(err.message,true); } finally { btn.disabled=false; }
  });
  $('#logout-btn').addEventListener('click',async()=>{ try { await api('/api/logout','POST',{}); showLogin(); } catch(e){toast(e.message,true);} });
  $('#menu-btn').addEventListener('click',()=>$('#sidebar').classList.toggle('open'));
  document.addEventListener('click',async e=>{
    const nav=e.target.closest('[data-view]'); if (nav) return jump(nav.dataset.view);
    const filter=e.target.closest('[data-filter]'); if(filter){state.filter=filter.dataset.filter;return renderPlanner();}
    const cancel=e.target.closest('[data-cancel]');if(cancel){if(confirm('Cancel this scheduled post?')){try{await api('/api/posts/'+cancel.dataset.cancel+'/cancel','POST',{});await refreshPart('posts');toast('Scheduled post canceled.');}catch(err){toast(err.message,true);}}return;}
    const retry=e.target.closest('[data-retry]');if(retry){if(confirm('Retry publishing this failed post now?')){try{await api('/api/posts/'+retry.dataset.retry+'/retry','POST',{});await refreshPart('posts');toast('Post queued for another attempt.');}catch(err){toast(err.message,true);}}return;}
    const copy=e.target.closest('[data-copy]');if(copy){try{await navigator.clipboard.writeText(copy.dataset.copy);toast('Public media URL copied.');}catch{toast('Could not access clipboard. Copy the URL manually.',true);}return;}
    const use=e.target.closest('[data-use]');if(use){$('#post-media').value=use.dataset.use;$('input[name="post-kind"][value="'+(urlIsImage(use.dataset.use)?'image':'reel')+'"]').checked=true;jump('compose');return;}
    const picker=e.target.closest('[data-picker-url]');if(picker){$('#post-media').value=picker.dataset.pickerUrl;$('input[name="post-kind"][value="'+picker.dataset.pickerType+'"]').checked=true;$('#library-picker').classList.add('hidden');updatePreview();return;}
    const del=e.target.closest('[data-delete-media]');if(del){if(confirm('Delete this uploaded media file?')){try{await api('/api/media/'+del.dataset.deleteMedia,'DELETE');state.media=state.media.filter(m=>m.id!==del.dataset.deleteMedia);renderLibrary();toast('Media file deleted.');}catch(err){toast(err.message,true);}}return;}
    const disconnect=e.target.closest('[data-disconnect]');if(disconnect){if(confirm('Disconnect Instagram account? Existing published post records will remain.')){try{await api('/api/accounts/'+disconnect.dataset.disconnect,'DELETE');await loadAll();toast('Instagram account disconnected.');}catch(err){toast(err.message,true);}}return;}
  });
  $('#refresh-posts').addEventListener('click',()=>refreshPart('posts'));
  $('#refresh-downloads').addEventListener('click',()=>refreshPart('downloads'));
  $('#clear-downloads').addEventListener('click',clearSelectedDownloads);
  $('#downloads-list').addEventListener('change',e=>{
    if (state.clearingDownloads) return;
    if (e.target.id === 'select-all-downloads') {
      state.selectedDownloads.clear();
      if (e.target.checked) state.downloads.filter(clearableDownload).forEach(d => state.selectedDownloads.add(d.id));
    } else if (e.target.matches('[data-select-download]')) {
      const id = e.target.dataset.selectDownload;
      if (!state.downloads.some(d => d.id === id && clearableDownload(d))) return;
      if (e.target.checked) state.selectedDownloads.add(id);
      else state.selectedDownloads.delete(id);
    } else return;
    updateDownloadSelection();
  });
  $('#post-account').addEventListener('change',updatePreview);
  $('#post-media').addEventListener('input',updatePreview);
  $('#post-caption').addEventListener('input',updatePreview);
  $$('input[name="post-kind"]').forEach(el=>el.addEventListener('change',updatePreview));
  $$('input[name="post-mode"]').forEach(el=>el.addEventListener('change',()=>{
    const isNow=$('input[name="post-mode"]:checked').value==='now';
    $('#schedule-field').classList.toggle('hidden',isNow);
    $('#post-schedule').required=!isNow;
    $('#submit-post').innerHTML=`${isNow?'Publish now':'Schedule post'} ${icon('arrow')}`;
  }));
  $('#pick-library').addEventListener('click',showPicker);
  $('#compose-upload').addEventListener('click',()=>$('#compose-file').click());
  $('#compose-file').addEventListener('change',e=>uploadFile(e.target.files[0],true));
  $('#library-file').addEventListener('change',e=>{uploadFile(e.target.files[0]);e.target.value='';});
  $('#upload-zone').addEventListener('click',()=>$('#library-file').click());
  ['dragenter','dragover'].forEach(type=>$('#upload-zone').addEventListener(type,e=>{e.preventDefault();$('#upload-zone').classList.add('dragover');}));
  ['dragleave','drop'].forEach(type=>$('#upload-zone').addEventListener(type,e=>{e.preventDefault();$('#upload-zone').classList.remove('dragover');if(type==='drop'&&e.dataTransfer.files?.[0])uploadFile(e.dataTransfer.files[0]);}));
  $('#compose-form').addEventListener('submit',async e=>{
    e.preventDefault(); const btn=$('#submit-post');btn.disabled=true;
    try {
      const mode=$('input[name="post-mode"]:checked').value;
      await api('/api/posts','POST',{
        accountId:$('#post-account').value,kind:$('input[name="post-kind"]:checked').value,
        mediaUrl:$('#post-media').value.trim(),caption:$('#post-caption').value,mode,
        scheduledAt:mode==='scheduled'?new Date($('#post-schedule').value).toISOString():undefined
      });
      await refreshPart('posts');toast(mode==='now'?'Post queued for immediate publishing.':'Post scheduled successfully.');jump('calendar');
    } catch(err){toast(err.message,true);}finally{btn.disabled=false;}
  });
  $('#download-form').addEventListener('submit',async e=>{
    e.preventDefault();const btn=$('#download-btn');btn.disabled=true;
    try{await api('/api/downloads','POST',{url:$('#download-url').value.trim(),confirmRights:$('#download-rights').checked});toast('Download started on your server.');$('#download-url').value='';$('#download-rights').checked=false;await refreshPart('downloads');}
    catch(err){toast(err.message,true);}finally{btn.disabled=false;}
  });
}
async function init() {
  bindEvents();
  $('#today-date').textContent=new Date().toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric',year:'numeric'});
  $('#timezone-name').textContent=`${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
  $('#post-schedule').value=localDateValue(new Date(Date.now()+3600000));
  $('#post-schedule').min=localDateValue(new Date(Date.now()+30000));
  try {
    const session = await api('/api/session');
    if (!session.authenticated) { showLogin();return; }
    showApp();await loadAll();
    const params=new URLSearchParams(location.search);jump(params.get('view')||'overview');
    if (params.get('oauth')==='connected') toast('Instagram account connected successfully.');
    if (params.get('oauth')==='denied') toast('Instagram connection was canceled.',true);
    if (params.get('oauth')==='failed') toast('Could not connect Instagram. Check server logs and Meta app settings.',true);
  } catch(err) { showLogin(); toast('Could not load workspace: '+err.message,true); }
  setInterval(()=>{
    if($('#app').classList.contains('hidden'))return;
    if(state.view==='calendar'||state.view==='overview')void refreshPart('posts');
    if(state.view==='downloader'&&state.downloads.some(d=>['downloading','queued'].includes(d.status)))void refreshPart('downloads');
  },15_000);
}
init();
