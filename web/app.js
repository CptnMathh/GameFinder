const token = new URLSearchParams(location.search).get('token') || '';
const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const state = {settings:{},games:[],storage:[],scan:{running:false},filter:{kind:'all',value:''},toolbarFilters:{genre:'',drive:'',controller:'',type:'',uninstall:'',image:'',minSize:0,maxSize:1000,favorites:false,savedTag:''},page:'library',search:'',menu:null,selectedGame:''};
let persistTimer;
let backgroundFrame=0,backgroundX=innerWidth*.5,backgroundY=innerHeight*.35,targetBackgroundX=backgroundX,targetBackgroundY=backgroundY;
function animateBackground(){backgroundX+=(targetBackgroundX-backgroundX)*.075;backgroundY+=(targetBackgroundY-backgroundY)*.075;document.body.style.setProperty('--light-x',`${backgroundX.toFixed(1)}px`);document.body.style.setProperty('--light-y',`${backgroundY.toFixed(1)}px`);if(Math.abs(targetBackgroundX-backgroundX)>.5||Math.abs(targetBackgroundY-backgroundY)>.5)backgroundFrame=requestAnimationFrame(animateBackground);else backgroundFrame=0}
window.addEventListener('pointermove',e=>{targetBackgroundX=e.clientX;targetBackgroundY=e.clientY;if(!backgroundFrame)backgroundFrame=requestAnimationFrame(animateBackground)},{passive:true});
let liquidRings=[];let lastRipple=0;
window.addEventListener('pointermove',e=>{const now=performance.now();if(now-lastRipple>85&&liquidRings.length<10){liquidRings.push({x:e.clientX,y:e.clientY,r:12,a:.13});lastRipple=now}},{passive:true});

async function api(path, body) {
  const options={headers:{'X-GameFinder-Token':token}};
  if(body!==undefined){options.method='POST';options.headers['Content-Type']='application/json';options.body=JSON.stringify(body)}
  const response=await fetch(path,options);
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.error||`Erreur ${response.status}`);
  return data;
}
function toast(message){const node=$('#toast');node.textContent=message;node.classList.remove('hidden');clearTimeout(toast.timer);toast.timer=setTimeout(()=>node.classList.add('hidden'),2800)}
function esc(text=''){return String(text).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))}
function size(bytes){if(!bytes)return'—';let n=bytes;for(const unit of ['o','Ko','Mo','Go','To']){if(n<1024||unit==='To')return`${n.toLocaleString('fr-FR',{maximumFractionDigits:1})} ${unit}`;n/=1024}return'—'}
function saveSettingsSoon(){clearTimeout(persistTimer);persistTimer=setTimeout(async()=>{try{await api('/api/settings',state.settings)}catch(e){toast(`Sauvegarde impossible : ${e.message}`)}},300)}
function setPage(page){state.page=page;$('#libraryPage').classList.toggle('hidden',page!=='library');$('#storagePage').classList.toggle('hidden',page!=='storage');$('#gameDetailPage').classList.toggle('hidden',page!=='detail');$('#libraryToolbar').classList.toggle('hidden',page!=='library');const selected=state.games.find(g=>g.key===state.selectedGame);$('#pageTitle').textContent=page==='storage'?'Stockage des disques':page==='detail'?(selected?.name||'Fiche du jeu'):filterTitle();renderNav();if(page==='storage')renderStorage();if(page==='detail')renderDetail()}
function filterTitle(){const f=state.filter;if(f.kind==='all')return'Tous les jeux';if(f.kind==='favorite')return'Favoris';return f.label||f.value}
function setFilter(kind,value,label){state.filter={kind,value,label};state.page='library';$('#pageTitle').textContent=filterTitle();setPage('library');renderGames()}
function renderNav(){
  const favCount=(state.settings.favorites||[]).length;
  const catCounts={};for(const g of state.games){const c=state.settings.assignments?.[g.key]?.category;if(c)catCounts[c]=(catCounts[c]||0)+1}
  const countBadge=n=>n?`<span class="nav-count">${n}</span>`:'';
  const primary=[['▦','Tous les jeux',state.games.length,()=>setFilter('all','')],['★','Favoris',favCount,()=>setFilter('favorite','')],['▤','Stockage des disques',0,()=>setPage('storage')]];
  $('#primaryNav').innerHTML=primary.map((x,i)=>`<button class="nav-item ${i===2?(state.page==='storage'?'active':''):state.page==='library'&&((i===0&&state.filter.kind==='all')||(i===1&&state.filter.kind==='favorite'))?'active':''}" data-nav="${i}"><span class="nav-icon">${x[0]}</span>${x[1]}${countBadge(x[2])}</button>`).join('');
  $$('#primaryNav .nav-item').forEach((b,i)=>b.onclick=primary[i][3]);
  $('#categoryNav').innerHTML=(state.settings.categories||[]).map(name=>`<button class="nav-item ${state.page==='library'&&state.filter.kind==='category'&&state.filter.value===name?'active':''}" data-category="${esc(name)}"><span class="nav-icon">▰</span>${esc(name)}${countBadge(catCounts[name]||0)}</button>`).join('');
  $$('#categoryNav [data-category]').forEach(b=>b.onclick=()=>setFilter('category',b.dataset.category,b.dataset.category));
  renderToolbarFilters();
}
function controllerLevel(g){if(g.controller_support&&g.controller_support!=='unknown')return g.controller_support;const words=[...(g.tags||[]),...(g.genres||[])].map(x=>String(x).toLocaleLowerCase('fr'));if(words.some(x=>/full controller support|prise en charge complète des manettes|manette complète|contrôleur complet/.test(x)))return'full';if(words.some(x=>/partial controller support|prise en charge partielle des manettes|manette partielle|contrôleur partiel/.test(x)))return'partial';return'unknown'}
function installationKind(g){if(g.uninstall)return'buy';if(g.source==='Crack'||g.source==='Dossier scanné')return'crack';return'unknown'}
function renderToolbarFilters(){const genres=[...new Set(state.games.flatMap(g=>g.genres||[]).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'fr'));$('#genreFilter').innerHTML='<option value="">Tous les genres</option>'+genres.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('');$('#genreFilter').value=state.toolbarFilters.genre;const drives=[...new Set(state.games.map(g=>g.drive).filter(Boolean))].sort();$('#driveFilter').innerHTML='<option value="">Tous les disques</option>'+drives.map(x=>`<option value="${esc(x)}">Disque ${esc(x)}</option>`).join('');$('#driveFilter').value=state.toolbarFilters.drive;$('#controllerFilter').value=state.toolbarFilters.controller;$('#typeFilter').value=state.toolbarFilters.type||'';$('#uninstallFilter').value=state.toolbarFilters.uninstall||'';$('#imageFilter').value=state.toolbarFilters.image||'';$('#sizeRange').value=state.toolbarFilters.maxSize??1000;$('#sizeMinRange').value=state.toolbarFilters.minSize??0;$('#sizeMaxLabel').textContent=Number($('#sizeRange').value)>=1000?'Sans limite':`${$('#sizeRange').value} Go`;$('#sizeMinLabel').textContent=`${$('#sizeMinRange').value} Go`;$('#favoritesFilter').checked=!!state.toolbarFilters.favorites;$('#savedFiltersInline').innerHTML=(state.settings.filters||[]).map(f=>`<button class="filter-chip ${state.toolbarFilters.savedTag===f.tag?'active':''}" data-saved-tag="${esc(f.tag)}" title="Filtrer : ${esc(f.tag)}">${esc(f.name)}</button>`).join('');const active=!!(state.toolbarFilters.genre||state.toolbarFilters.drive||state.toolbarFilters.controller||state.toolbarFilters.type||state.toolbarFilters.uninstall||state.toolbarFilters.image||state.toolbarFilters.favorites||state.toolbarFilters.savedTag||state.toolbarFilters.minSize>0||state.toolbarFilters.maxSize<1000);$('#clearFilters').classList.toggle('hidden',!active)}
function matches(g){
  const q=state.search.trim().toLocaleLowerCase('fr');
  const tags=[...(g.tags||[]),...(g.genres||[])];
  if(q&&!`${g.name} ${g.path} ${tags.join(' ')}`.toLocaleLowerCase('fr').includes(q))return false;
  const f=state.filter;
  const ignored=(state.settings.ignored||[]).some(x=>(x.key||x)===g.key);
  if(ignored)return false;
  if(f.kind==='favorite'&&!(state.settings.favorites||[]).includes(g.key))return false;
  if(f.kind==='category'&&state.settings.assignments?.[g.key]?.category!==f.value)return false;
  if(f.kind==='tag'&&!tags.some(t=>t.toLocaleLowerCase('fr').includes(f.value.toLocaleLowerCase('fr'))))return false;
  const quick=state.toolbarFilters;
  if(quick.genre&&!(g.genres||[]).includes(quick.genre))return false;
  if(quick.drive&&g.drive!==quick.drive)return false;
  if(quick.favorites&&!(state.settings.favorites||[]).includes(g.key))return false;
  if(quick.controller&&controllerLevel(g)!==quick.controller)return false;
  if(quick.type&&g.source!==quick.type)return false;
  if(quick.uninstall&&installationKind(g)!==quick.uninstall)return false;
  if(quick.image==='yes'&&!g.image)return false;
  if(quick.image==='no'&&g.image)return false;
  if(quick.savedTag&&!tags.some(t=>t.toLocaleLowerCase('fr').includes(quick.savedTag.toLocaleLowerCase('fr'))))return false;
  const gb=1024**3;if(g.size<Number(quick.minSize||0)*gb||g.size>Number(quick.maxSize||1000)*gb)return false;
  return true;
}
const SORT_OPTIONS=[['name:asc','Nom A → Z'],['name:desc','Nom Z → A'],['size:desc','Taille ↓'],['size:asc','Taille ↑']];
function sortMode(){const key=state.settings.sort==='size'?'size':'name';return `${key}:${state.settings.sort_dir||(key==='size'?'desc':'asc')}`}
function sortLabel(){const[key,dir]=sortMode().split(':');return `${key==='size'?'Taille':'Nom'} ${dir==='asc'?'↑':'↓'}`}
function currentGames(){const items=state.games.filter(matches);const[key,dir]=sortMode().split(':');const sign=dir==='asc'?1:-1;if(key==='size')items.sort((a,b)=>(a.size-b.size)*sign);else items.sort((a,b)=>a.name.localeCompare(b.name,'fr')*sign);return items}
function imageMarkup(g, compact=false){const title=esc(g.name);return g.image?`<img class="cover ${compact?'compact-cover':''}" loading="lazy" src="${esc(g.image)}" alt="Jaquette de ${title}" onerror="this.classList.add('hidden');if(this.nextElementSibling)this.nextElementSibling.classList.remove('hidden')"><div class="cover-placeholder hidden">${esc(g.name.split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase())}</div>`:`<div class="cover-placeholder">${esc(g.name.split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase())}</div>`}
function menuButton(g){return `<button class="game-menu-button" data-menu="${esc(g.key)}" aria-label="Plus d’actions pour ${esc(g.name)}">⋯</button>`}
function renderGames(){
  if(state.page!=='library')return;
  const games=currentGames();const grid=$('#gameGrid');const list=state.settings.layout==='Liste';
  grid.className=list?'list-view':'game-grid';grid.style.setProperty('--columns',Math.max(2,Math.min(10,Number(state.settings.columns)||4)));
  $('#viewToggle').innerHTML=list?'▦ <span>Grille</span>':'▤ <span>Liste</span>';
  $('#sortSelect').textContent=sortLabel();
  $('#gameCount').textContent=`${games.length} jeu${games.length===1?'':'x'}`;
  if(!games.length){grid.innerHTML=`<div class="empty-state">${state.games.length?'Aucun jeu dans cette sélection.':'Tes jeux enregistrés apparaîtront ici. Lance un scan ou ajoute des emplacements dans les paramètres.'}</div>`;return}
  if(list){
    grid.innerHTML=`<div class="list-header ${state.settings.show_banner===false?'no-banner':''}">${state.settings.show_banner===false?'':'<span>Visuel</span>'}<span>Jeu</span><span>Taille totale</span><span>Emplacement · disque</span><span>Actions</span></div>`+games.map(g=>`<article class="game-row ${state.settings.show_banner===false?'no-banner':''}" data-card="${esc(g.key)}">
      ${state.settings.show_banner===false?'':`<button class="row-banner" data-open-game="${esc(g.key)}" aria-label="Ouvrir la fiche de ${esc(g.name)}">${imageMarkup(g,true)}</button>`}<div class="row-game"><button class="row-title" data-open-game="${esc(g.key)}">${esc(g.name)}</button><div class="row-sub">${esc((g.tags||[]).slice(0,3).join(' · ')||g.source)}</div></div>
      <div class="row-size">${state.settings.show_size===false?'':'<span class="row-label">Taille</span>'+size(g.size)}</div><div class="row-location" title="${esc(g.path)}">${state.settings.show_drive===false?'':`<b>Disque ${esc(g.drive)}</b>`}<span>${esc(g.path)}</span><small>${esc(g.source)}</small></div>
      <div class="row-actions"><button class="play-button" data-action="launch" data-key="${esc(g.key)}">▶ Jouer</button>${menuButton(g)}</div></article>`).join('');
  } else {
    grid.innerHTML=games.map(g=>{
      const details=[state.settings.show_size!==false?size(g.size):'',state.settings.show_drive!==false?`Disque ${g.drive}`:'',g.source].filter(Boolean).join('　·　');
      const tags=state.settings.show_tags===false?'':(g.tags||g.genres||[]).slice(0,3).map(t=>`<span class="tag-chip">${esc(t)}</span>`).join('');
      const favorite=(state.settings.favorites||[]).includes(g.key);
      return `<article class="game-card" data-card="${esc(g.key)}"><div class="cover-wrap" data-open-game="${esc(g.key)}">${imageMarkup(g)}<div class="cover-shade"></div><div class="cover-title">${esc(g.name)}</div></div>
        <div class="game-info"><div class="game-title-row"><button class="game-title" data-open-game="${esc(g.key)}" title="${esc(g.name)}">${esc(g.name)}</button><button class="favorite ${favorite?'on':''}" data-action="favorite" data-key="${esc(g.key)}" title="Favori">${favorite?'★':'☆'}</button></div>
        <div class="game-meta" title="${esc(g.path)}">${esc(details)}</div><div class="game-tags">${tags}</div><div class="card-play-row"><button class="play-button" data-action="launch" data-key="${esc(g.key)}">▶　Jouer</button>${menuButton(g)}</div></div></article>`
    }).join('');
  }
  bindCardEffects();
}
function bindCardEffects(){
  $$('.game-card').forEach(card=>{
    card.addEventListener('pointermove',e=>{const r=card.getBoundingClientRect();const x=(e.clientX-r.left)/r.width;const y=(e.clientY-r.top)/r.height;card.style.setProperty('--mx',`${x*100}%`);card.style.setProperty('--my',`${y*100}%`);card.style.transform=`rotateX(${((.5-y)*4).toFixed(2)}deg) rotateY(${((x-.5)*4).toFixed(2)}deg) translateY(-2px)`});
    card.addEventListener('pointerleave',()=>{card.style.transform='';card.style.setProperty('--mx','50%');card.style.setProperty('--my','50%')});
  });
}
function openGame(key){state.selectedGame=key;setPage('detail')}
function renderDetail(){
  const host=$('#gameDetailPage');const g=state.games.find(x=>x.key===state.selectedGame);if(!g){host.innerHTML='<div class="empty-state">Jeu introuvable.</div>';return}
  const tags=[...new Set([...(g.tags||[]),...(g.genres||[])])].slice(0,10);const favorite=(state.settings.favorites||[]).includes(g.key);
  const ownTags=state.settings.assignments?.[g.key]?.tags||[];
  host.innerHTML=`<button class="back-library" id="backToLibrary">←　Retour à la bibliothèque</button><section class="detail-hero" style="--hero-image:url('${esc(g.image||'')}')"><div class="detail-poster">${imageMarkup(g)}</div><div class="detail-copy"><div class="eyebrow">${esc(g.source)}　·　DISQUE ${esc(g.drive)}</div><h2>${esc(g.name)}</h2><div class="detail-tags">${tags.map(t=>`<span class="tag-chip">${esc(t)}</span>`).join('')}</div><p>${esc(g.description||'Jeu installé dans ta bibliothèque. Ouvre le dossier ou lance-le directement depuis GameFinder.')}</p><div class="detail-actions"><button class="play-button" data-action="launch" data-key="${esc(g.key)}">▶　Jouer</button><button class="favorite ${favorite?'on':''}" data-action="favorite" data-key="${esc(g.key)}" title="${favorite?'Retirer des favoris':'Ajouter aux favoris'}" aria-label="${favorite?'Retirer des favoris':'Ajouter aux favoris'}">${favorite?'★':'☆'}</button>${menuButton(g)}</div></div></section><section class="detail-lower"><div class="detail-section"><div class="eyebrow">INSTALLATION</div><h3>Informations du jeu</h3><div class="detail-facts"><div><small>Taille totale</small><b>${size(g.size)}</b></div><div><small>Disque</small><b>${esc(g.drive)}</b></div><div><small>Source</small><b>${esc(g.source)}</b></div><div><small>Développeur</small><b>${esc(g.developer||'—')}</b></div></div><button class="folder-link" data-action="open" data-key="${esc(g.key)}">▣　Ouvrir le dossier d’installation</button><div class="detail-path">${esc(g.path)}</div></div><div class="detail-section"><div class="eyebrow">DÉCOUVERTE</div><h3>Genres et tags</h3><div class="detail-tags detail-tags-lower">${tags.length?tags.map(t=>`<span class="tag-chip">${esc(t)}</span>`).join(''):'<span class="muted">Aucun tag renseigné</span>'}</div><div class="tag-editor-actions"><button class="button subtle" id="detailAddTag">＋ Ajouter un tag</button><button class="button subtle" id="detailRemoveTag" ${ownTags.length?'':'disabled'}>− Retirer un tag</button></div><small class="tag-editor-note">Tags personnalisés : ${ownTags.length?ownTags.map(esc).join(' · '):'aucun'}${g.store_url?' · ':''}</small>${g.store_url?`<button class="button subtle" data-store="${esc(g.store_url)}">Voir la fiche Steam ↗</button>`:''}</div></section>`;
  $('#backToLibrary').onclick=()=>setPage('library');
  $('#detailAddTag').onclick=()=>quickDialog('Ajouter un tag à '+g.name,'Nouveau tag personnalisé','Ex. Coopération',async value=>{try{await api('/api/game',{key:g.key,action:'tag_add',value});await refreshState()}catch(e){toast(e.message)}});
  $('#detailRemoveTag').onclick=()=>openTagRemoval(g);
}
function renderStorage(){
  const host=$('#storageContent');const drives=state.storage||[];
  if(!drives.length){host.innerHTML='<div class="empty-state">Lance un scan pour afficher le stockage par disque et par jeu.</div>';return}
  host.innerHTML=drives.map((d,index)=>{
    const usedPct=d.total?Math.min(100,d.used/d.total*100):0;const colors=['#7c9cff','#67d3b1','#f2bd62','#d78cff','#fa8296','#56c6e8','#a9d36b','#ff9b55','#b2a2ff','#52c9a5'];const denominator=Math.max(d.gameSize,1);
    const segments=d.games.map((g,i)=>`<div class="drive-segment" style="width:${Math.max(0.2,g.size/denominator*100)}%;--segment:${colors[i%colors.length]}" data-tip="${esc(g.name)} · ${size(g.size)}" tabindex="0" aria-label="${esc(g.name)} : ${size(g.size)}"></div>`).join('');
    return `<section class="drive-card"><div class="drive-header"><div class="drive-title"><span class="drive-icon">${esc(d.drive)}</span><span>Disque ${esc(d.drive)}</span></div><span class="drive-game-count">${d.games.length} installations</span></div>
      <div class="drive-summary"><span>Jeux <b>${size(d.gameSize)}</b></span><span>Occupé <b>${size(d.used)}</b></span><span>Disponible <b>${size(d.free)} / ${size(d.total)}</b></span></div>
      <div class="disk-track" aria-label="Espace disque occupé"><div class="disk-fill" style="width:${usedPct}%"></div></div><div class="storage-caption"><span>Espace occupé sur le disque</span><span>${usedPct.toFixed(0)} %</span></div>
      <div class="game-share-heading"><b>Répartition de tes jeux</b><span>${size(d.gameSize)} au total</span></div><div class="drive-track game-share-track">${segments}<div class="bar-tooltip" role="tooltip"></div></div>
      <div class="drive-legend">${d.games.map((g,i)=>`<div class="drive-game"><span class="game-swatch" style="--segment:${colors[i%colors.length]}"></span><div class="drive-game-name">${esc(g.name)}</div><div class="drive-game-size">${size(g.size)}</div><div class="drive-game-path" title="${esc(g.path)}">${esc(g.path)}</div></div>`).join('')}</div>
    </section>`
  }).join('');
  $$('.game-share-track').forEach(track=>{const tooltip=$('.bar-tooltip',track);track.addEventListener('pointermove',e=>{const segment=e.target.closest('.drive-segment');if(!segment){tooltip.classList.remove('visible');return}tooltip.textContent=segment.dataset.tip;tooltip.classList.add('visible');const r=track.getBoundingClientRect();tooltip.style.left=`${Math.max(60,Math.min(r.width-60,e.clientX-r.left))}px`});track.addEventListener('pointerleave',()=>tooltip.classList.remove('visible'));track.addEventListener('focusin',e=>{const segment=e.target.closest('.drive-segment');if(segment){tooltip.textContent=segment.dataset.tip;tooltip.classList.add('visible');tooltip.style.left='50%'}});track.addEventListener('focusout',()=>tooltip.classList.remove('visible'))});
}
function showMenu(button,g){
  closeMenu();const rect=button.getBoundingClientRect();const menu=document.createElement('div');menu.className='context-menu';
  const item=(label,action,extra='')=>`<button class="context-item ${extra}" data-menu-action="${action}">${label}</button>`;
  const assignedCategory=state.settings.assignments?.[g.key]?.category||'';
  menu.innerHTML=item('Ouvrir le dossier','open')+item('Lancer le jeu','launch')+(g.store_url?item('Voir la fiche du jeu','store'):'')+item('Ajouter / retirer des favoris','favorite')+
    item('Ignorer (pas un jeu)','ignore')+
    `<div class="context-group"><button class="context-item" data-menu-action="category">Classer dans une catégorie <span>›</span></button><div class="context-sub">${(state.settings.categories||[]).map(c=>`<button class="context-item" data-category-choice="${esc(c)}">${assignedCategory===c?'✓　':''}${esc(c)}</button>`).join('')}<button class="context-item ${assignedCategory?'':'disabled'}" data-category-remove="1" ${assignedCategory?'':'disabled'}>− Retirer de cette catégorie</button><button class="context-item" data-category-new="1">＋ Créer une catégorie…</button></div></div>`+
    `<div class="context-group"><button class="context-item" data-menu-action="tags">Tags personnalisés <span>›</span></button><div class="context-sub"><button class="context-item" data-tag-add="1">＋ Ajouter un tag…</button><button class="context-item" data-tag-remove="1">− Retirer un tag…</button></div></div><div class="context-separator"></div>`+
    item('Désinstaller / supprimer…','remove','danger');
  menu.style.top=`${Math.min(rect.bottom+4,innerHeight-310)}px`;menu.style.left=`${Math.min(rect.right-220,innerWidth-235)}px`;document.body.append(menu);state.menu=menu;
  menu.addEventListener('click',async e=>{
    const btn=e.target.closest('button');if(!btn)return;
    if(btn.dataset.menuAction==='category'||btn.dataset.menuAction==='tags')return;
    try{
      if(btn.dataset.categoryChoice)await api('/api/game',{key:g.key,action:'category',value:btn.dataset.categoryChoice});
      else if(btn.dataset.categoryRemove)await api('/api/game',{key:g.key,action:'category',value:''});
      else if(btn.dataset.categoryNew){const name=prompt('Nom de la nouvelle catégorie');if(name?.trim()){await api('/api/category',{name:name.trim()});await api('/api/game',{key:g.key,action:'category',value:name.trim()})}}
      else if(btn.dataset.tagAdd){const value=prompt('Tag à ajouter');if(value?.trim())await api('/api/game',{key:g.key,action:'tag_add',value:value.trim()})}
      else if(btn.dataset.tagRemove){closeMenu();openTagRemoval(g);return}
      else if(btn.dataset.menuAction==='remove'){
        closeMenu();openRemovalConfirmation(g);return
      } else if(btn.dataset.menuAction==='store'&&g.store_url){window.open(g.store_url,'_blank','noopener')}
      else if(btn.dataset.menuAction==='favorite')await api('/api/game',{key:g.key,action:'favorite'});
      else if(btn.dataset.menuAction==='ignore'){await api('/api/ignore',{key:g.key});toast('Élément ignoré. Tu peux le restaurer dans les paramètres.')}
      else if(['open','launch'].includes(btn.dataset.menuAction))await api('/api/action',{key:g.key,action:btn.dataset.menuAction});
      closeMenu();await refreshState();
    }catch(err){toast(err.message)}
  });
}
function closeMenu(){state.menu?.remove();state.menu=null}
function openSortMenu(anchor){closeMenu();const rect=anchor.getBoundingClientRect();const current=sortMode();const menu=document.createElement('div');menu.className='context-menu sort-menu';menu.innerHTML=SORT_OPTIONS.map(([mode,label])=>`<button class="context-item${mode===current?' sort-active':''}" data-sort-mode="${mode}">${mode===current?'✓ ':''}${label}</button>`).join('');menu.style.top=`${Math.min(rect.bottom+4,innerHeight-190)}px`;menu.style.left=`${Math.max(8,Math.min(rect.left,innerWidth-240))}px`;document.body.append(menu);state.menu=menu;menu.addEventListener('click',e=>{const b=e.target.closest('[data-sort-mode]');if(!b)return;const[key,dir]=b.dataset.sortMode.split(':');state.settings.sort=key;state.settings.sort_dir=dir;saveSettingsSoon();$('#sortSelect').textContent=sortLabel();closeMenu();renderGames()})}
async function refreshState(){try{const data=await api('/api/state');state.settings=data.settings;state.games=data.games;state.storage=data.storage;state.scan=data.scan;renderNav();renderGames();renderStorage();if(state.page==='detail')renderDetail();updateStatus()}catch(e){toast(e.message)}}
function updateStatus(){
  $('#sideStatus').textContent=state.scan.running?'Scan en cours…':'Bibliothèque sauvegardée localement';
  $('#statusText').textContent=state.scan.progress||'Prêt.';
  let scanAdvice='';if(state.settings.last_scan){const match=String(state.settings.last_scan).match(/(\d{2})\/(\d{2})\/(\d{4})/);if(match){const last=new Date(+match[3],+match[2]-1,+match[1]);if(Date.now()-last.getTime()>30*86400000)scanAdvice=' · Un scan est recommandé (plus d’un mois)'}}
  $('#lastScan').textContent=state.settings.last_scan?`Dernier scan : ${state.settings.last_scan}${scanAdvice}`:'';
  $('#scanBtn').disabled=!!state.scan.running;$('#scanBtn').innerHTML=state.scan.running?'⟳ <span>Scan en cours…</span>':'⟳ <span>Scanner les jeux</span>';
  document.body.classList.toggle('scanning',!!state.scan.running);$('#scanProgress').classList.toggle('hidden',!state.scan.running);
  if(state.scan.error)toast(state.scan.error);
}
async function scan(){try{await api('/api/scan',{});state.scan.running=true;updateStatus();toast('Scan démarré. Les résultats apparaîtront au fur et à mesure.')}catch(e){toast(e.message)}}
function addLocationPath(path){const clean=String(path||'').trim().replace(/\\+$/,'');if(!clean)return;if(!(state.settings.locations||[]).some(item=>item.toLocaleLowerCase('fr')===clean.toLocaleLowerCase('fr'))){state.settings.locations.push(clean);syncSettingsForm();saveSettingsSoon();toast('Emplacement ajouté. Lance un scan pour actualiser la bibliothèque.')}}
function syncSettingsForm(){
  $('#settingLayout').value=state.settings.layout||'Grille';$('#settingColumns').value=String(state.settings.columns||4);
  $('#settingSize').checked=state.settings.show_size!==false;$('#settingDrive').checked=state.settings.show_drive!==false;
  $('#settingTags').checked=state.settings.show_tags!==false;$('#settingBanner').checked=state.settings.show_banner!==false;
  $('#locationList').innerHTML=(state.settings.locations||[]).map((path,i)=>`<div class="location-item"><span title="${esc(path)}">${esc(path)}</span><button class="remove-location" data-remove-location="${i}" title="Retirer">×</button></div>`).join('')||'<div class="location-item"><span>Aucun emplacement ajouté</span></div>';
  $$('#locationList [data-remove-location]').forEach(b=>b.onclick=()=>{state.settings.locations.splice(Number(b.dataset.removeLocation),1);syncSettingsForm();saveSettingsSoon()});
  $('#ignoredList').innerHTML=(state.settings.ignored||[]).map(x=>`<div class="location-item"><span title="${esc(x.path||x.key||x)}">${esc(x.name||x.key||x)}</span><button class="remove-location" data-restore-ignored="${esc(x.key||x)}" title="Restaurer">↶</button></div>`).join('')||'<div class="location-item"><span>Aucun élément ignoré</span></div>';
  $$('[data-restore-ignored]').forEach(b=>b.onclick=async()=>{try{await api('/api/ignored/restore',{key:b.dataset.restoreIgnored});await refreshState();syncSettingsForm()}catch(e){toast(e.message)}});
  $('#ignoredCount').textContent=(state.settings.ignored||[]).length||'';
}
function openSettings(){syncSettingsForm();$('#settingsModal').classList.remove('hidden')}
function closeSettings(){ $('#settingsModal').classList.add('hidden') }
function quickDialog(title,label,placeholder,submit,buttonLabel='Enregistrer',initialValue=''){const box=document.createElement('div');box.className='modal quick-modal';box.innerHTML=`<div class="modal-backdrop"></div><form class="modal-panel quick-panel"><div class="eyebrow">BIBLIOTHÈQUE</div><h2>${esc(title)}</h2><label>${esc(label)}<input class="dialog-input" autofocus placeholder="${esc(placeholder)}"></label><div class="dialog-actions"><button type="button" class="button subtle">Annuler</button><button class="button primary">${esc(buttonLabel)}</button></div></form>`;document.body.append(box);const input=$('.dialog-input',box);input.value=initialValue;input.focus();input.select();$('.button.subtle',box).onclick=()=>box.remove();box.onclick=e=>{if(e.target.classList.contains('modal-backdrop'))box.remove()};$('.quick-panel',box).onsubmit=e=>{e.preventDefault();const value=input.value.trim();box.remove();if(value)submit(value)};input.onkeydown=e=>{if(e.key==='Escape')box.remove()}}
function openTagRemoval(g){const own=state.settings.assignments?.[g.key]?.tags||[];if(!own.length){toast('Aucun tag personnalisé à retirer pour ce jeu.');return}const box=document.createElement('div');box.className='modal quick-modal';box.innerHTML=`<div class="modal-backdrop"></div><section class="modal-panel quick-panel tag-remove-panel"><div class="eyebrow">TAGS PERSONNALISÉS</div><h2>Retirer un tag</h2><p class="muted">Choisis le tag à retirer de « ${esc(g.name)} ».</p><div class="tag-remove-list">${own.map(tag=>`<button class="tag-remove-choice" data-remove-tag="${esc(tag)}"><span>${esc(tag)}</span><b>−</b></button>`).join('')}</div><div class="dialog-actions"><button type="button" class="button subtle" data-close-dialog>Fermer</button></div></section>`;document.body.append(box);box.onclick=async e=>{if(e.target.classList.contains('modal-backdrop')||e.target.closest('[data-close-dialog]')){box.remove();return}const choice=e.target.closest('[data-remove-tag]');if(!choice)return;try{await api('/api/game',{key:g.key,action:'tag_remove',value:choice.dataset.removeTag});box.remove();await refreshState();toast(`Tag « ${choice.dataset.removeTag} » retiré.`)}catch(err){toast(err.message)}}}
function openRemovalConfirmation(g){const action=g.uninstall?'uninstall':'delete';const box=document.createElement('div');box.className='modal quick-modal';box.innerHTML=`<div class="modal-backdrop"></div><section class="modal-panel quick-panel removal-panel" role="alertdialog" aria-modal="true" aria-labelledby="removalTitle"><div class="eyebrow">GESTION DU JEU</div><h2 id="removalTitle">${action==='uninstall'?'Désinstaller le jeu ?':'Supprimer le dossier du jeu ?'}</h2><p>${action==='uninstall'?`GameFinder va ouvrir le désinstalleur de « ${esc(g.name)} ».`:`Aucun désinstalleur n’est enregistré. Le dossier « ${esc(g.name)} » sera supprimé définitivement.`}</p><div class="removal-facts"><span>Taille du jeu</span><b>${size(g.size)}</b><span>Emplacement</span><b class="removal-path">${esc(g.path)}</b></div><div class="dialog-actions"><button type="button" class="button subtle" data-cancel-removal>Annuler</button><button type="button" class="button danger-confirm-button" data-confirm-removal>${action==='uninstall'?'Désinstaller':'Supprimer le dossier'}</button></div></section>`;document.body.append(box);const dismiss=()=>box.remove();box.onclick=async e=>{if(e.target.classList.contains('modal-backdrop')||e.target.closest('[data-cancel-removal]')){dismiss();return}if(!e.target.closest('[data-confirm-removal]'))return;const confirmButton=$('[data-confirm-removal]',box);confirmButton.disabled=true;confirmButton.textContent=action==='uninstall'?'Ouverture…':'Suppression…';try{await api('/api/action',{key:g.key,action});dismiss();await refreshState();toast(action==='uninstall'?'Désinstalleur lancé.':'Dossier du jeu supprimé.')}catch(err){confirmButton.disabled=false;confirmButton.textContent=action==='uninstall'?'Désinstaller':'Supprimer le dossier';toast(err.message)}};box.onkeydown=e=>{if(e.key==='Escape')dismiss()}}
const WHEEL_COLORS=['#6389ef','#7dd6bf','#efc66c','#d78cff','#fa8296','#56c6e8','#a9d36b','#ff9b55','#b2a2ff','#52c9a5','#f2a0b5','#8fb4ff'];
const picker={pool:[],query:'',spinning:false,shown:[],rotation:0,raf:0,canvas:null,ctx:null};
function pickerEntries(){if(picker.pool.length)return picker.pool.map(e=>({name:e.name,game:e.game||null}));return currentGames().map(g=>({name:g.name,game:g}))}
function openRandomPicker(){
  picker.pool=[];picker.shown=[];picker.rotation=0;picker.spinning=false;
  const box=document.createElement('div');box.className='modal quick-modal random-modal';
  box.innerHTML=`<div class="modal-backdrop" data-close-random></div><section class="modal-panel quick-panel random-panel" role="dialog" aria-modal="true" aria-labelledby="randomTitle">
    <div class="random-head"><div><div class="eyebrow">BIBLIOTHÈQUE</div><h2 id="randomTitle">Jeu au hasard</h2></div><button class="close-btn" data-close-random title="Fermer" aria-label="Fermer">×</button></div>
    <label class="random-search">Filtrer les jeux<input class="dialog-input" id="randomQuery" placeholder="Tape un nom de jeu…"></label>
    <div class="random-custom"><input class="dialog-input" id="randomCustom" placeholder="Ou ajoute un nom libre…" maxlength="60"><button class="button subtle" id="randomCustomAdd" type="button">＋</button></div>
    <div class="random-pool" id="randomPool"></div>
    <div class="random-candidates" id="randomCandidates"></div>
    <div class="random-wheel-wrap"><canvas id="randomWheel" width="640" height="640"></canvas><div class="random-pointer"></div></div>
    <div class="random-result muted" id="randomResult">La roue choisira parmi ta sélection filtrée.</div>
    <div class="dialog-actions"><button class="button subtle" id="randomReset">Toute la sélection</button><button class="button primary" id="randomSpin">🎡 Tourner</button></div>
  </section>`;
  document.body.append(box);
  const close=()=>{cancelAnimationFrame(picker.raf);box.remove()};
  box.onclick=e=>{if(e.target.closest('[data-close-random]'))close()};
  picker.canvas=$('#randomWheel',box);picker.ctx=picker.canvas.getContext('2d');
  const candidates=()=>{const q=$('#randomQuery',box).value.trim().toLocaleLowerCase('fr');const taken=new Set(picker.pool.map(e=>e.name.toLocaleLowerCase('fr')));return currentGames().filter(g=>!taken.has(g.name.toLocaleLowerCase('fr'))&&(!q||`${g.name} ${(g.tags||[]).join(' ')}`.toLocaleLowerCase('fr').includes(q)))};
  const renderChips=()=>{const chips=picker.pool.map((e,i)=>`<span class="pool-chip"><span class="pool-chip-name">${esc(e.name)}${e.game?'':' <small>libre</small>'}</span><button data-unpool="${i}" title="Retirer de la roue">×</button></span>`).join('');const total=pickerEntries().length;$('#randomPool',box).innerHTML=chips||`<span class="muted" style="font-size:10px">Pool : toute la sélection filtrée (${total} jeu${total>1?'x':''})</span>`};
  const renderCandidates=()=>{const list=candidates().slice(0,60);$('#randomCandidates',box).innerHTML=list.map(g=>`<div class="random-candidate"><span>${esc(g.name)}<small>${esc(g.source)}</small></span><button data-pool="${esc(g.key)}" title="Ajouter à la roue">＋</button></div>`).join('')||'<div class="muted" style="font-size:10px;padding:6px">Aucun jeu à ajouter.</div>'};
  const addToPool=(name,game)=>{const clean=String(name||'').trim();if(!clean)return;if(picker.pool.some(e=>e.name.toLocaleLowerCase('fr')===clean.toLocaleLowerCase('fr'))){toast('Ce nom est déjà dans la roue.');return}picker.pool.push({name:clean,game:game||null});renderChips();renderCandidates()};
  $('#randomCandidates',box).onclick=e=>{const b=e.target.closest('[data-pool]');if(!b)return;const g=state.games.find(x=>x.key===b.dataset.pool);if(g)addToPool(g.name,g)};
  $('#randomPool',box).onclick=e=>{const b=e.target.closest('[data-unpool]');if(!b)return;picker.pool.splice(Number(b.dataset.unpool),1);renderChips();renderCandidates()};
  const addCustom=()=>{const input=$('#randomCustom',box);addToPool(input.value,null);input.value='';input.focus()};
  $('#randomCustomAdd',box).onclick=addCustom;
  $('#randomCustom',box).onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();addCustom()}if(e.key==='Escape')close()};
  $('#randomReset',box).onclick=()=>{picker.pool=[];$('#randomQuery',box).value='';$('#randomCustom',box).value='';renderChips();renderCandidates()};
  $('#randomQuery',box).oninput=()=>renderCandidates();
  $('#randomQuery',box).onkeydown=e=>{if(e.key==='Escape')close()};
  const shortName=name=>name.length>18?name.slice(0,17)+'…':name;
  const drawWheel=()=>{const ctx=picker.ctx,entries=picker.shown,n=entries.length,cx=320,cy=320,r=310;ctx.clearRect(0,0,640,640);ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fillStyle='#1a2231';ctx.fill();ctx.strokeStyle='#2a3345';ctx.lineWidth=6;ctx.stroke();if(!n)return;const seg=Math.PI*2/n;for(let i=0;i<n;i++){const a0=picker.rotation+i*seg,a1=a0+seg;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,a0,a1);ctx.closePath();ctx.fillStyle=WHEEL_COLORS[i%WHEEL_COLORS.length];ctx.fill();ctx.strokeStyle='rgba(8,12,20,.55)';ctx.lineWidth=4;ctx.stroke();ctx.save();ctx.translate(cx,cy);ctx.rotate(a0+seg/2);ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillStyle='#fff';ctx.font='700 24px Inter,"Segoe UI",sans-serif';ctx.shadowColor='rgba(0,0,0,.6)';ctx.shadowBlur=8;ctx.fillText(shortName(entries[i].name),r-18,0);ctx.restore()}ctx.beginPath();ctx.arc(cx,cy,r*.17,0,Math.PI*2);ctx.fillStyle='#141a26';ctx.fill();ctx.strokeStyle='#ffffff26';ctx.lineWidth=5;ctx.stroke()};
  const showResult=e=>{const g=e.game;if(!g){$('#randomResult',box).innerHTML=`<div class="random-winner">🏆 ${esc(e.name)}</div><div class="muted" style="font-size:10px">Nom ajouté manuellement — aucun jeu associé</div>`;return}$('#randomResult',box).innerHTML=`<div class="random-winner">🏆 ${esc(g.name)}</div><div class="muted" style="font-size:10px">${esc(g.source)} · ${size(g.size)}</div><div class="random-result-actions"><button class="button subtle" id="randomOpen">Ouvrir la fiche</button><button class="button subtle" id="randomLaunch">Jouer</button></div>`;$('#randomOpen',box).onclick=()=>{close();openGame(g.key)};$('#randomLaunch',box).onclick=async()=>{try{await api('/api/action',{key:g.key,action:'launch'});toast(`${g.name} lancé.`)}catch(e){toast(e.message)}}};
  $('#randomSpin',box).onclick=()=>{if(picker.spinning)return;const full=pickerEntries();if(!full.length){toast('Aucun jeu dans la sélection.');return}picker.shown=full.length>14?[...full].sort(()=>Math.random()-.5).slice(0,14):full;const w=Math.floor(Math.random()*picker.shown.length),n=picker.shown.length,seg=Math.PI*2/n,pointer=-Math.PI/2,from=picker.rotation,need=(pointer-w*seg-seg/2-from)%(Math.PI*2),wrapped=need<0?need+Math.PI*2:need,to=from+Math.PI*2*6+wrapped,dur=4200+Math.random()*800,t0=performance.now();picker.spinning=true;const btn=$('#randomSpin',box);btn.disabled=true;btn.textContent='…';const step=now=>{const t=Math.min(1,(now-t0)/dur),e=1-Math.pow(1-t,4);picker.rotation=from+(to-from)*e;drawWheel();if(t<1){picker.raf=requestAnimationFrame(step)}else{picker.rotation=((to%(Math.PI*2))+Math.PI*2)%(Math.PI*2);picker.spinning=false;btn.disabled=false;btn.textContent='🎡 Tourner';drawWheel();showResult(picker.shown[w])}};picker.raf=requestAnimationFrame(step)};
  renderChips();renderCandidates();drawWheel();
}
function addCategory(){quickDialog('Nouvelle catégorie','Nom de la catégorie','Ex. Jeux de course',name=>api('/api/category',{name}).then(refreshState).catch(e=>toast(e.message)),'Créer')}
function manageCategories(){const categories=[...(state.settings.categories||[])];const box=document.createElement('div');box.className='modal quick-modal';box.innerHTML=`<div class="modal-backdrop"></div><section class="modal-panel quick-panel category-manager"><div class="eyebrow">BIBLIOTHÈQUE</div><h2>Organiser les catégories</h2><p class="muted">Glisse la poignée ⠿ pour réordonner. Tu peux aussi utiliser les flèches.</p><div class="category-manager-list">${categories.map((name,i)=>`<div class="category-manager-row" data-index="${i}"><span class="category-grip" draggable="true" title="Glisser pour déplacer" aria-label="Glisser pour déplacer">⠿</span><b>${esc(name)}</b><button data-move="-1" title="Monter" ${i===0?'disabled':''}>↑</button><button data-move="1" title="Descendre" ${i===categories.length-1?'disabled':''}>↓</button><button data-rename="1" title="Renommer">✎</button><button data-delete="1" title="Supprimer">×</button></div>`).join('')||'<p class="muted">Aucune catégorie pour le moment.</p>'}</div><div class="dialog-actions"><button class="button subtle" data-close-dialog>Terminé</button></div></section>`;document.body.append(box);const list=$('.category-manager-list',box);let dragged=-1;list.addEventListener('dragstart',e=>{const row=e.target.closest('.category-manager-row');if(!row||!e.target.closest('.category-grip')){e.preventDefault();return}dragged=Number(row.dataset.index);row.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(dragged))});list.addEventListener('dragend',()=>{$$('.category-manager-row',list).forEach(row=>row.classList.remove('dragging','drop-target'))});list.addEventListener('dragover',e=>{const row=e.target.closest('.category-manager-row');if(!row)return;e.preventDefault();$$('.category-manager-row',list).forEach(item=>item.classList.toggle('drop-target',item===row));e.dataTransfer.dropEffect='move'});list.addEventListener('drop',async e=>{const row=e.target.closest('.category-manager-row');if(!row)return;e.preventDefault();const source=dragged>=0?dragged:Number(e.dataTransfer.getData('text/plain')),target=Number(row.dataset.index);if(source<0||source===target)return;const [moved]=categories.splice(source,1);categories.splice(target,0,moved);try{await api('/api/category',{action:'reorder',categories});state.settings.categories=categories;box.remove();renderNav();manageCategories()}catch(err){toast(err.message)}});box.onclick=async e=>{if(e.target.classList.contains('modal-backdrop')||e.target.closest('[data-close-dialog]')){box.remove();return}const row=e.target.closest('[data-index]');if(!row)return;const i=Number(row.dataset.index);try{if(e.target.closest('[data-move]')){const j=i+Number(e.target.closest('[data-move]').dataset.move);[categories[i],categories[j]]=[categories[j],categories[i]];await api('/api/category',{action:'reorder',categories});state.settings.categories=categories;box.remove();renderNav();manageCategories()}else if(e.target.closest('[data-rename]')){quickDialog('Renommer la catégorie','Nouveau nom','Nom de la catégorie',async name=>{try{await api('/api/category',{action:'rename',old:categories[i],name});box.remove();await refreshState();manageCategories()}catch(err){toast(err.message)}},'Enregistrer',categories[i])}else if(e.target.closest('[data-delete]')){if(confirm(`Supprimer la catégorie « ${categories[i]} » ? Les jeux resteront dans la bibliothèque.`)){await api('/api/category',{action:'delete',name:categories[i]});box.remove();await refreshState();manageCategories()}}}catch(err){toast(err.message)}}}
function addFilter(){quickDialog('Nouveau filtre','Tag ou genre à inclure','Ex. Coopération',tag=>quickDialog('Nommer le filtre','Nom affiché dans la bibliothèque',tag,name=>api('/api/filter',{name,tag}).then(refreshState).catch(e=>toast(e.message))))}

document.addEventListener('click',e=>{
  const menuBtn=e.target.closest('[data-menu]');if(menuBtn){const game=state.games.find(g=>g.key===menuBtn.dataset.menu);if(game)showMenu(menuBtn,game);return}
  const action=e.target.closest('[data-action]');if(action){const g=state.games.find(x=>x.key===action.dataset.key);if(!g)return;if(action.dataset.action==='favorite'){api('/api/game',{key:g.key,action:'favorite'}).then(refreshState).catch(err=>toast(err.message))}else api('/api/action',{key:g.key,action:action.dataset.action}).catch(err=>toast(err.message));return}
  const store=e.target.closest('[data-store]');if(store){if(store.dataset.store)window.open(store.dataset.store,'_blank','noopener');return}
  const open=e.target.closest('[data-open-game]');if(open){openGame(open.dataset.openGame);return}
  if(state.menu&&!e.target.closest('.context-menu'))closeMenu();
});
$('#scanBtn').onclick=scan;$('#settingsBtn').onclick=openSettings;$('#addCategory').onclick=addCategory;$('#manageCategories').onclick=manageCategories;$('#addFilter').onclick=addFilter;$('#randomGame').onclick=()=>{const choices=currentGames();if(!choices.length){toast('Aucun jeu dans cette sélection.');return}openRandomPicker()};
$('#quitBtn').onclick=async()=>{try{$('#quitBtn').disabled=true;$('#quitBtn').innerHTML='⏻ <span>Fermeture…</span>';await api('/api/quit',{});$('#statusText').textContent='GameFinder est arrêté.';window.close()}catch(e){$('#quitBtn').disabled=false;$('#quitBtn').innerHTML='⏻ <span>Quitter</span>';toast(`Fermeture impossible : ${e.message}`)}};
$('#openFirefox').onclick=async()=>{try{await api('/api/open-firefox',{});toast('GameFinder ouvert dans Firefox.')}catch(e){toast(e.message)}};
$('#settingsStorage').onclick=()=>{closeSettings();setPage('storage')};
$$('[data-close="settings"]').forEach(b=>b.onclick=closeSettings);
$('#addLocation').onclick=()=>{const input=$('#locationInput');addLocationPath(input.value);input.value=''};
$('#addManualGame').onclick=async()=>{const input=$('#manualGamePath');try{await api('/api/manual',{path:input.value});input.value='';await refreshState();toast('Jeu ajouté à la bibliothèque.')}catch(e){toast(e.message)}};
$('#browseManualGame').onclick=async()=>{const button=$('#browseManualGame');button.disabled=true;try{const result=await api('/api/browse',{mode:'file',initial:$('#manualGamePath').value.trim()});if(result.path)$('#manualGamePath').value=result.path}catch(e){toast(e.message)}finally{button.disabled=false}};
$('#browseLocation').onclick=async()=>{const button=$('#browseLocation');button.disabled=true;button.textContent='Ouverture…';try{const result=await api('/api/browse',{initial:$('#locationInput').value.trim()});if(result.path){$('#locationInput').value=result.path;addLocationPath(result.path)}}catch(e){toast(e.message)}finally{button.disabled=false;button.textContent='📁 Parcourir…'}};
$('#locationInput').addEventListener('keydown',e=>{if(e.key==='Enter')$('#addLocation').click()});
$('#settingLayout').onchange=e=>{state.settings.layout=e.target.value;saveSettingsSoon();renderGames()};
$('#settingColumns').onchange=e=>{state.settings.columns=Number(e.target.value);saveSettingsSoon();renderGames()};
for(const [id,key] of [['settingSize','show_size'],['settingDrive','show_drive'],['settingTags','show_tags'],['settingBanner','show_banner']])$(`#${id}`).onchange=e=>{state.settings[key]=e.target.checked;saveSettingsSoon();renderGames()};
$('#viewToggle').onclick=()=>{state.settings.layout=state.settings.layout==='Liste'?'Grille':'Liste';saveSettingsSoon();renderGames()};
$('#sortSelect').onclick=e=>{e.stopPropagation();openSortMenu(e.currentTarget)};
$('#searchInput').oninput=e=>{state.search=e.target.value;renderGames()};
$('#genreFilter').onchange=e=>{state.toolbarFilters.genre=e.target.value;renderToolbarFilters();renderGames()};
$('#driveFilter').onchange=e=>{state.toolbarFilters.drive=e.target.value;renderToolbarFilters();renderGames()};
$('#controllerFilter').onchange=e=>{state.toolbarFilters.controller=e.target.value;renderToolbarFilters();renderGames()};
$('#typeFilter').onchange=e=>{state.toolbarFilters.type=e.target.value;renderToolbarFilters();renderGames()};
$('#uninstallFilter').onchange=e=>{state.toolbarFilters.uninstall=e.target.value;renderToolbarFilters();renderGames()};
$('#imageFilter').onchange=e=>{state.toolbarFilters.image=e.target.value;renderToolbarFilters();renderGames()};
$('#favoritesFilter').onchange=e=>{state.toolbarFilters.favorites=e.target.checked;renderToolbarFilters();renderGames()};
$('#sizeMinRange').oninput=e=>{state.toolbarFilters.minSize=Number(e.target.value);if(state.toolbarFilters.minSize>state.toolbarFilters.maxSize){state.toolbarFilters.maxSize=state.toolbarFilters.minSize;$('#sizeRange').value=state.toolbarFilters.maxSize}$('#sizeMinLabel').textContent=`${state.toolbarFilters.minSize} Go`;$('#sizeMaxLabel').textContent=state.toolbarFilters.maxSize>=1000?'Sans limite':`${state.toolbarFilters.maxSize} Go`;renderGames()};
$('#sizeRange').oninput=e=>{state.toolbarFilters.maxSize=Number(e.target.value);if(state.toolbarFilters.maxSize<state.toolbarFilters.minSize){state.toolbarFilters.minSize=state.toolbarFilters.maxSize;$('#sizeMinRange').value=state.toolbarFilters.minSize}$('#sizeMinLabel').textContent=`${state.toolbarFilters.minSize} Go`;$('#sizeMaxLabel').textContent=state.toolbarFilters.maxSize>=1000?'Sans limite':`${state.toolbarFilters.maxSize} Go`;renderGames()};
$('#filterToggle').onclick=()=>{const open=$('#filterToolbar').classList.toggle('hidden')===false;$('#filterToggle').setAttribute('aria-expanded',String(open));$('#filterToggle').classList.toggle('active',open)};
$('#savedFiltersInline').onclick=e=>{const chip=e.target.closest('[data-saved-tag]');if(!chip)return;state.toolbarFilters.savedTag=state.toolbarFilters.savedTag===chip.dataset.savedTag?'':chip.dataset.savedTag;renderToolbarFilters();renderGames()};$('#clearFilters').onclick=()=>{state.toolbarFilters={genre:'',drive:'',controller:'',type:'',uninstall:'',image:'',minSize:0,maxSize:1000,favorites:false,savedTag:''};renderToolbarFilters();renderGames()};
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('#searchInput').focus()}if(e.key==='Escape')closeMenu()});

// Always paint an immediate, local liquid surface. The optional ThreeJS layer
// replaces it only after its module and texture both load successfully.
function startLiquidFallback(){const canvas=$('#liquidFallbackCanvas'),ctx=canvas?.getContext('2d');if(!ctx)return;let width=0,height=0,scale=1;const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;const resize=()=>{scale=Math.min(devicePixelRatio||1,1.25);width=innerWidth;height=innerHeight;canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);ctx.setTransform(scale,0,0,scale,0,0)};resize();window.addEventListener('resize',resize,{passive:true});const draw=(now)=>{if(document.body.classList.contains('liquid-ready'))return;if(!reduced)requestAnimationFrame(draw);if(document.hidden)return;ctx.clearRect(0,0,width,height);const t=now*.00016;const paintLiquid=(cx,cy,r,phase,colors)=>{ctx.save();ctx.globalCompositeOperation='screen';ctx.filter='blur(24px)';const light=ctx.createRadialGradient(cx-r*.24,cy-r*.27,r*.03,cx,cy,r);light.addColorStop(0,colors[0]);light.addColorStop(.5,colors[1]);light.addColorStop(1,'rgba(11,17,31,0)');ctx.beginPath();for(let i=0;i<=100;i++){const a=i/100*Math.PI*2;const wave=1+.105*Math.sin(a*3+t*1.2+phase)+.052*Math.cos(a*5-t*.8+phase*.4)+.025*Math.sin(a*8+t*.55);const x=cx+Math.cos(a)*r*wave,y=cy+Math.sin(a)*r*.72*wave;if(!i)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.closePath();ctx.fillStyle=light;ctx.fill();ctx.filter='none';ctx.lineWidth=2;ctx.strokeStyle='rgba(177,202,255,.22)';ctx.shadowColor=colors[0];ctx.shadowBlur=18;ctx.stroke();ctx.restore()};const extent=Math.max(width,height);paintLiquid(reduced?width*.42:backgroundX+Math.sin(t*.7)*40,height*.39,extent*.58,t,['rgba(123,170,255,.42)','rgba(76,111,205,.20)']);paintLiquid(width*(.76+Math.sin(t*.65)*.035),height*(.61+Math.cos(t*.8)*.035),extent*.40,-t*1.4,['rgba(220,149,255,.25)','rgba(134,84,194,.14)']);paintLiquid(width*(.22+Math.cos(t*.55)*.035),height*(.86+Math.sin(t)*.025),extent*.29,t*.7,['rgba(113,240,221,.2)','rgba(47,149,155,.12)']);if(!reduced){ctx.save();ctx.globalCompositeOperation='screen';ctx.filter='none';liquidRings=liquidRings.filter(r=>r.a>.01);for(const ring of liquidRings){ctx.beginPath();ctx.ellipse(ring.x,ring.y,ring.r*1.9,ring.r,0,-.2,Math.PI*2);ctx.strokeStyle=`rgba(182,210,255,${ring.a})`;ctx.lineWidth=1.3;ctx.stroke();ring.r+=1.3;ring.a*=.965}ctx.restore()}};requestAnimationFrame(draw);document.body.classList.remove('liquid-ready');document.body.classList.add('liquid-fallback')}
async function initLiquidEffect(){startLiquidFallback();if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;for(let attempt=0;attempt<3;attempt++){try{const module=await Promise.race([import('https://cdn.jsdelivr.net/npm/threejs-components@0.0.27/build/backgrounds/liquid1.min.js'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Chargement du module Liquid interrompu')),12000))]);const effect=module.default($('#liquidCanvas'));effect.liquidPlane.material.metalness=.75;effect.liquidPlane.material.roughness=.25;effect.liquidPlane.uniforms.displacementScale.value=5;effect.setRain(false);await Promise.race([effect.loadImage('/liquid.webp'),new Promise(r=>setTimeout(r,8000))]);document.body.classList.remove('liquid-fallback');document.body.classList.add('liquid-ready');return}catch(error){console.warn(`GameFinder Liquid: tentative ${attempt+1}/3 échouée.`,error)}}console.warn('GameFinder Liquid: animation locale activée.')}
(async()=>{initLiquidEffect();await refreshState();setPage('library');setInterval(async()=>{if(state.scan.running){const before=state.games.length;await refreshState();if(state.games.length!==before)renderGames()}},1200)})().catch(e=>toast(`Connexion au moteur impossible : ${e.message}`));
