import './style.css';
import * as THREE from 'three';
import { Viewer, VIEWS, disposeObject } from './viewer.js';
import { loadFile, pickMainFile, ACCEPT, formatOf } from './loaders/index.js';
import { ModelTree, LayerList } from './ui/tree.js';
import { MeasureTool } from './tools/measure.js';
import { splitByConnectivity, splitByBrepFaces, meshStats } from './tools/split.js';
import { icon } from './ui/icons.js';

const $ = (id) => document.getElementById(id);
const viewportEl = $('viewport');
const viewer = new Viewer(viewportEl);
const measure = new MeasureTool(viewer);
viewer.pickLevel = 'part';

const state = {
  file: null,
  format: null,
  fileSize: 0,
  bg: 'dark',
  leftOpen: true,
  rightOpen: true,
};

// ===================================================================== toolbar
const BGS = {
  dark: { css: 'radial-gradient(ellipse at 50% 30%, #3a4658 0%, #232b37 55%, #161b22 100%)', light: false, label: '어두운 그라데이션', shot: '#232b37' },
  light: { css: 'radial-gradient(ellipse at 50% 30%, #ffffff 0%, #e4e9f0 60%, #c9d2de 100%)', light: true, label: '밝은 그라데이션', shot: '#e4e9f0' },
  black: { css: '#000000', light: false, label: '검정 (CAD)', shot: '#000000' },
  white: { css: '#ffffff', light: true, label: '흰색', shot: '#ffffff' },
};
const RENDER_MODES = [
  ['shaded', '음영'],
  ['shaded-edges', '음영 + 모서리'],
  ['wireframe', '와이어프레임'],
  ['edges', '모서리만'],
  ['xray', 'X-Ray (투명)'],
];
const VIEW_ITEMS = [
  ['front', '정면', '1'], ['back', '배면', '2'], ['left', '좌측면', '3'], ['right', '우측면', '4'],
  ['top', '평면 (위)', '5'], ['bottom', '저면 (아래)', '6'], ['iso', '등각 (남동)', '7'],
  ['isoSW', '등각 (남서)', ''], ['isoNE', '등각 (북동)', ''], ['isoNW', '등각 (북서)', ''],
];

const toolbar = $('toolbar');
const tb = {};
function addBtn(id, ic, label, title, onClick, { caret = false, req = null } = {}) {
  const b = document.createElement('button');
  b.className = 'tb-btn';
  b.innerHTML = icon(ic) + (label ? `<span class="lbl">${label}</span>` : '') + (caret ? `<span class="caret">▾</span>` : '');
  b.title = title;
  b.addEventListener('click', (e) => onClick(e, b));
  b.dataset.req = req || '';
  toolbar.appendChild(b);
  tb[id] = b;
  return b;
}
const sep = () => toolbar.appendChild(Object.assign(document.createElement('span'), { className: 'tb-sep' }));

addBtn('open', 'open', '열기', '파일 열기 (Ctrl+O)', () => $('fileInput').click());
addBtn('shot', 'camera', '', '스크린샷 저장 (PNG)', () => screenshot(), { req: 'any' });
sep();
addBtn('fit', 'fit', '', '전체 보기 (F)', () => viewer.fit(true), { req: 'any' });
addBtn('views', 'cube', '뷰', '표준 뷰', (e, b) => showMenu(b, VIEW_ITEMS.map(([k, l, kb]) => ({ label: l, kbd: kb, action: () => viewer.setView(k) }))), { caret: true, req: '3d' });
addBtn('proj', 'persp', '', '원근 / 직교 투영 전환 (P)', () => toggleProjection(), { req: '3d' });
sep();
addBtn('render', 'shaded', '표시', '표시 모드', (e, b) => showMenu(b, RENDER_MODES.map(([k, l]) => ({ label: l, checked: viewer.renderMode === k, action: () => setRenderMode(k) }))), { caret: true, req: '3d' });
addBtn('grid', 'grid', '', '그리드 (G)', () => toggleGrid(), { req: '3d' });
addBtn('axes', 'axes', '', '좌표축', () => toggleAxes(), { req: 'any' });
addBtn('bg', 'bg', '', '배경', (e, b) => showMenu(b, Object.entries(BGS).map(([k, v]) => ({ label: v.label, checked: state.bg === k, action: () => setBackground(k) }))));
sep();
addBtn('measure', 'ruler', '측정', '측정 도구 (M)', () => togglePanel('measurePanel'), { req: 'any' });
addBtn('section', 'section', '단면', '단면 (S)', () => togglePanel('sectionPanel'), { req: '3d' });
addBtn('explode', 'explode', '분해', '분해 / 분리 (E)', () => togglePanel('explodePanel'), { req: '3d' });
sep();
addBtn('pick', 'pointer', '부품', '선택 단위', (e, b) => showMenu(b, [
  { label: '부품 (개별 바디)', checked: viewer.pickLevel === 'part', action: () => setPickLevel('part') },
  { label: '어셈블리 (최상위)', checked: viewer.pickLevel === 'assembly', action: () => setPickLevel('assembly') },
]), { caret: true, req: '3d' });
addBtn('hide', 'eyeOff', '', '선택 숨기기 (H)', () => hideSelection(), { req: 'any' });
addBtn('isolate', 'isolate', '', '선택만 보기 (I)', () => isolateSelection(), { req: '3d' });
addBtn('showAll', 'showAll', '', '모두 보기 (A)', () => viewer.showAll(), { req: 'any' });
sep();
addBtn('panelL', 'panelL', '', '왼쪽 패널', () => togglePanelSide('left'));
addBtn('panelR', 'panelR', '', '오른쪽 패널', () => togglePanelSide('right'));
addBtn('full', 'full', '', '전체 화면', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()));
addBtn('help', 'help', '', '도움말 / 단축키 (?)', () => showHelp());

function updateToolbar() {
  for (const b of Object.values(tb)) {
    const req = b.dataset.req;
    b.disabled = (req === 'any' && viewer.mode === 'empty') || (req === '3d' && viewer.mode !== '3d');
  }
  tb.proj.innerHTML = icon(viewer.isOrtho ? 'ortho' : 'persp');
  tb.proj.title = viewer.isOrtho ? '직교 투영 (P: 원근으로 전환)' : '원근 투영 (P: 직교로 전환)';
  tb.grid.classList.toggle('active', viewer.gridVisible !== false && viewer.mode === '3d');
  tb.axes.classList.toggle('active', viewer.axes.visible);
  tb.measure.classList.toggle('active', !$('measurePanel').classList.contains('hidden'));
  tb.section.classList.toggle('active', !$('sectionPanel').classList.contains('hidden'));
  tb.explode.classList.toggle('active', !$('explodePanel').classList.contains('hidden'));
  tb.panelL.classList.toggle('active', state.leftOpen);
  tb.panelR.classList.toggle('active', state.rightOpen);
  tb.pick.querySelector('.lbl').textContent = viewer.pickLevel === 'part' ? '부품' : '어셈블리';
  const rm = RENDER_MODES.find(([k]) => k === viewer.renderMode);
  tb.render.querySelector('.lbl').textContent = rm ? rm[1].split(' ')[0] : '표시';
}

// ===================================================================== menus
let openMenu = null;
function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}
function showMenu(anchor, items) {
  const wasSame = openMenu && openMenu._anchor === anchor;
  closeMenu();
  if (wasSame) return;
  const m = document.createElement('div');
  m.className = 'menu';
  m._anchor = anchor;
  for (const it of items) {
    if (it === '-') { m.appendChild(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.innerHTML = `<span>${it.label}</span>${it.kbd ? `<span class="kbd">${it.kbd}</span>` : ''}`;
    if (it.checked) b.classList.add('checked');
    b.addEventListener('click', () => { closeMenu(); it.action(); });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - m.offsetWidth - 8) + 'px';
  m.style.top = r.bottom + 4 + 'px';
  openMenu = m;
}
document.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.contains(e.target) && !e.target.closest('.tb-btn')) closeMenu();
  if (!$('contextMenu').contains(e.target)) $('contextMenu').classList.add('hidden');
});

// ===================================================================== file loading
$('fileInput').accept = ACCEPT;
$('fileInput').addEventListener('change', (e) => {
  if (e.target.files.length) openFiles([...e.target.files]);
  e.target.value = '';
});
$('emptyOpen').addEventListener('click', () => $('fileInput').click());
document.querySelectorAll('[data-sample]').forEach((b) => b.addEventListener('click', () => openUrl(`samples/${b.dataset.sample}`)));

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropOverlay').classList.add('show'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').classList.remove('show'); } });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').classList.remove('show');
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) openFiles(files);
});

function setLoading(msg) {
  if (msg) {
    $('loading').classList.remove('hidden');
    $('loadingText').textContent = msg;
  } else $('loading').classList.add('hidden');
}

async function openUrl(url) {
  try {
    setLoading('다운로드 중...');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const name = decodeURIComponent(url.split('/').pop().split('?')[0]) || 'model';
    await openFiles([new File([blob], name)]);
  } catch (err) {
    setLoading(null);
    toast('파일을 불러올 수 없습니다: ' + err.message, true);
  }
}

async function openFiles(files) {
  const main = pickMainFile(files);
  if (!main) {
    toast('지원하는 모델 파일이 없습니다.', true);
    return;
  }
  const t0 = performance.now();
  try {
    setLoading(`${main.name} 여는 중...`);
    const res = await loadFile(main, files, (m) => setLoading(m));
    setLoading('장면 구성 중...');
    await new Promise((r) => setTimeout(r, 0));
    measure.clearAll();
    closeFloatPanels();
    if (res.kind === '2d') {
      viewer.setDrawing(res.cad);
      res.cad.setLightBackground(BGS[state.bg].light);
      measure.unit = unitName(res.drawing.insUnits);
      switchTab('layers');
    } else {
      viewer.setModel(res.object);
      measure.unit = ['step', 'iges', 'brep'].includes(res.format.key) ? 'mm' : '';
      switchTab('tree');
    }
    state.file = main;
    state.format = res.format;
    state.fileSize = main.size;
    state.drawing = res.drawing;
    $('fileTitle').textContent = main.name;
    document.title = `${main.name} - Web 3D Viewer`;
    $('emptyState').classList.add('hidden');
    tree.build(viewer.model);
    layers.build(viewer.cad);
    renderProps();
    renderSectionPanel();
    $('explodeRange').value = 0;
    $('explodeVal').textContent = '0%';
    status(`${main.name} 로드 완료 (${((performance.now() - t0) / 1000).toFixed(2)}초)`);
    if (res.kind === '2d' && !res.cad.entities.length) toast('도면에 표시할 모델 공간 객체가 없습니다. (손상되었거나 지원하지 않는 버전일 수 있습니다)', true);
    if (res.cad?.skippedTexts) toast(`문자가 너무 많아 ${res.cad.skippedTexts}개는 표시하지 않았습니다.`);
  } catch (err) {
    console.error(err);
    toast(`열기 실패: ${err.message}`, true);
    status('열기 실패');
  } finally {
    setLoading(null);
    updateToolbar();
  }
}

function unitName(code) {
  return { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km' }[code] || '';
}

// ===================================================================== tree / layers
const tree = new ModelTree($('treeView'), viewer, {
  onSelect: (o, add) => viewer.select([o], add),
  onFocus: (o) => viewer.fit(true, [o]),
  onContext: (x, y) => showContextMenu(x, y),
});
const layers = new LayerList($('layerView'), viewer, () => viewer.requestRender());
layers.build(null);
$('treeSearch').addEventListener('input', (e) => {
  if (activeTab === 'tree') tree.setFilter(e.target.value);
  else layers.refresh(e.target.value);
});
let activeTab = 'tree';
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('#leftTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('treeView').classList.toggle('hidden', tab !== 'tree');
  $('layerView').classList.toggle('hidden', tab !== 'layers');
  $('treeSearch').value = '';
  tree.filter = '';
  if (tab === 'tree') tree.build(viewer.model);
  else layers.refresh('');
}
document.querySelectorAll('#leftTabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

viewer.addEventListener('selection', () => {
  tree.syncSelection();
  renderProps();
});
viewer.addEventListener('visibility', () => tree.refreshVisibility());
viewer.addEventListener('model-structure', () => {
  tree.build(viewer.model);
  renderProps();
});
viewer.addEventListener('camera', updateToolbar);

// ===================================================================== pointer interaction
const canvas = viewer.renderer.domElement;
let down = null;
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, button: e.button, t: performance.now() };
});
canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
  const btn = down.button;
  down = null;
  if (moved) return;
  if (btn === 0) handleClick(e);
  else if (btn === 2) handleRightClick(e);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('dblclick', (e) => {
  if (measure.mode === 'area' || (measure.mode === 'distance' && measure.points.length >= 2)) {
    measure.complete();
    return;
  }
  if (measure.mode) return;
  const hit = viewer.pick(e.clientX, e.clientY);
  if (hit) viewer.setPivot(hit.point);
  else viewer.fit(true);
});

function handleClick(e) {
  if (viewer.viewCube.click(e.clientX, e.clientY)) return;
  if (viewer.transform.dragging || viewer.transform.axis) return;
  if (measure.onClick(e.clientX, e.clientY)) return;
  const add = e.ctrlKey || e.metaKey || e.shiftKey;
  const hit = viewer.pick(e.clientX, e.clientY);
  if (viewer.mode === '2d') {
    const id = hit ? viewer.cad.entityFromHit(hit) : null;
    if (id != null) viewer.selectEntity(id, add);
    else if (!add) viewer.clearEntitySelection();
    return;
  }
  if (hit) viewer.select([viewer.selectableFor(hit.object)], add);
  else if (!add) viewer.clearSelection();
}

function handleRightClick(e) {
  if (measure.mode) {
    // right click finishes area / polyline distance, otherwise cancels
    if (measure.points.length) measure.complete();
    measure.cancel();
    return;
  }
  if (viewer.mode === '3d') {
    const hit = viewer.pick(e.clientX, e.clientY);
    if (hit) {
      const o = viewer.selectableFor(hit.object);
      if (!viewer.selection.has(o)) viewer.select([o], false);
    }
  } else if (viewer.mode === '2d') {
    const hit = viewer.pick(e.clientX, e.clientY);
    const id = hit ? viewer.cad.entityFromHit(hit) : null;
    if (id != null && !viewer.entitySel?.has(id)) viewer.selectEntity(id, false);
  }
  showContextMenu(e.clientX, e.clientY);
}

let moveRaf = 0, lastMove = null, lastCoordT = 0;
canvas.addEventListener('pointermove', (e) => {
  lastMove = e;
  if (moveRaf) return;
  moveRaf = requestAnimationFrame(() => {
    moveRaf = 0;
    const ev = lastMove;
    const overCube = viewer.mode === '3d' && viewer.viewCube.hover(ev.clientX, ev.clientY);
    canvas.style.cursor = overCube ? 'pointer' : '';
    if (down) return;
    if (measure.mode) measure.onMove(ev.clientX, ev.clientY);
    const now = performance.now();
    if (now - lastCoordT > 70) {
      lastCoordT = now;
      updateCoord(ev);
    }
  });
});
canvas.addEventListener('pointerleave', () => ($('statusCoord').textContent = ''));

function updateCoord(e) {
  if (viewer.mode === 'empty') return;
  let p = null;
  if (viewer.mode === '2d') p = viewer.pickPlane(e.clientX, e.clientY);
  else {
    const hit = viewer.pick(e.clientX, e.clientY, { lines: false });
    p = hit?.point || null;
  }
  if (!p) {
    $('statusCoord').textContent = '';
    return;
  }
  const o = viewer.model?.userData.cadOrigin;
  if (o) p = p.clone().add(o);
  const f = (n) => n.toFixed(3);
  $('statusCoord').textContent = viewer.mode === '2d' ? `X ${f(p.x)}   Y ${f(p.y)}` : `X ${f(p.x)}   Y ${f(p.y)}   Z ${f(p.z)}`;
}

// ===================================================================== actions
function setRenderMode(k) {
  viewer.setRenderMode(k);
  updateToolbar();
}
function toggleProjection() {
  viewer.setOrtho(!viewer.isOrtho);
  updateToolbar();
}
function toggleGrid() {
  viewer.setGridVisible(viewer.gridVisible === false);
  updateToolbar();
}
function toggleAxes() {
  viewer.setAxesVisible(!viewer.axes.visible);
  updateToolbar();
}
function setBackground(k) {
  state.bg = k;
  viewer.setBackground(BGS[k].css, BGS[k].light);
  try { localStorage.setItem('w3v.bg', k); } catch { /* ignore */ }
}
function setPickLevel(l) {
  viewer.pickLevel = l;
  viewer.clearSelection();
  updateToolbar();
}
function selected() {
  return [...viewer.selection];
}
function hideSelection() {
  if (viewer.mode === '2d') {
    // hide the layers of the selected entities
    const ids = [...(viewer.entitySel?.keys() || [])];
    for (const id of ids) viewer.cad.setLayerVisible(viewer.cad.entities[id].layer, false);
    viewer.clearEntitySelection();
    layers.refresh();
    viewer.requestRender();
    return;
  }
  const s = selected();
  if (!s.length) return;
  viewer.clearSelection();
  viewer.hide(s);
}
function isolateSelection() {
  const s = selected();
  if (s.length) viewer.isolate(s);
}
function togglePanelSide(side) {
  const key = side === 'left' ? 'leftOpen' : 'rightOpen';
  state[key] = !state[key];
  $(side === 'left' ? 'leftPanel' : 'rightPanel').classList.toggle('collapsed', !state[key]);
  updateToolbar();
}

function screenshot() {
  const url = viewer.screenshot(BGS[state.bg].shot);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(state.file?.name || 'view').replace(/\.[^.]+$/, '')}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
  a.click();
  status('스크린샷을 저장했습니다.');
}

// ===================================================================== floating panels
function togglePanel(id) {
  const el = $(id);
  const show = el.classList.contains('hidden');
  el.classList.toggle('hidden', !show);
  if (id === 'measurePanel' && !show) {
    measure.setMode(null);
    syncMeasureModes();
  }
  if (id === 'sectionPanel') renderSectionPanel();
  updateToolbar();
}
function closeFloatPanels() {
  for (const id of ['measurePanel', 'sectionPanel', 'explodePanel']) $(id).classList.add('hidden');
  measure.setMode(null);
  syncMeasureModes();
}
document.querySelectorAll('[data-close]').forEach((b) => {
  b.innerHTML = icon('close', 14);
  b.addEventListener('click', () => togglePanel(b.dataset.close));
});

// ---- measure
const MEASURE_HINTS = {
  distance: '두 점을 클릭하세요. (점/모서리에 자동 스냅, 더블클릭으로 연속 거리 완료)',
  angle: '세 점을 클릭하세요. 두 번째 점이 꼭짓점입니다.',
  point: '좌표를 확인할 지점을 클릭하세요.',
  area: '다각형 꼭짓점을 차례로 클릭하고 더블클릭(또는 우클릭)으로 완료하세요.',
};
$('measureModes').addEventListener('click', (e) => {
  const m = e.target.dataset.m;
  if (!m) return;
  measure.setMode(measure.mode === m ? null : m);
  syncMeasureModes();
});
function syncMeasureModes() {
  document.querySelectorAll('#measureModes button').forEach((b) => b.classList.toggle('active', b.dataset.m === measure.mode));
  $('measureHint').textContent = measure.mode ? MEASURE_HINTS[measure.mode] : '측정 방식을 선택하세요.';
}
$('measureClear').addEventListener('click', () => measure.clearAll());
measure.addEventListener('change', renderMeasureList);
function renderMeasureList() {
  const el = $('measureList');
  if (!measure.results.length) {
    el.innerHTML = '<p class="muted">측정 결과가 없습니다.</p>';
    return;
  }
  const names = { distance: '거리', angle: '각도', point: '좌표', area: '면적' };
  el.innerHTML = '';
  measure.results.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'm-item';
    row.innerHTML = `<span class="m-type">${names[r.type]}</span><span class="m-val"></span><button class="icon-btn" title="삭제">${icon('trash', 14)}</button>`;
    row.querySelector('.m-val').innerHTML = `${esc(r.text)}${r.detail ? `<small>${esc(r.detail)}</small>` : ''}`;
    row.querySelector('button').addEventListener('click', () => measure.remove(i));
    el.appendChild(row);
  });
  el.scrollTop = el.scrollHeight;
}

// ---- section
function renderSectionPanel() {
  const body = $('sectionBody');
  body.innerHTML = '';
  for (const axis of ['x', 'y', 'z']) {
    const s = viewer.sections[axis];
    const row = document.createElement('div');
    row.className = 'sec-row';
    row.innerHTML = `<label><input type="checkbox" ${s.on ? 'checked' : ''}/> <span class="ax" style="color:${{ x: '#ff6b6b', y: '#5ee38a', z: '#5aa2ff' }[axis]}">${axis.toUpperCase()}</span></label>`
      + `<input type="range" min="0" max="1000" value="${s.pos * 1000}" />`
      + `<button class="icon-btn" title="방향 반전">${icon('rotate', 14)}</button>`;
    const [chk, range, flip] = [row.querySelector('input[type=checkbox]'), row.querySelector('input[type=range]'), row.querySelector('button')];
    chk.addEventListener('change', () => viewer.setSection(axis, { on: chk.checked }));
    range.addEventListener('input', () => viewer.setSection(axis, { pos: range.value / 1000, on: true }) || (chk.checked = true));
    flip.addEventListener('click', () => viewer.setSection(axis, { flip: !viewer.sections[axis].flip }));
    body.appendChild(row);
  }
  const opts = document.createElement('div');
  opts.className = 'row gap';
  opts.innerHTML = `<label class="row" style="gap:6px"><input type="checkbox" id="secShowPlane" ${viewer.showSectionPlane !== false ? 'checked' : ''}/> 단면 평면 표시</label><button class="btn sm" id="secReset">해제</button>`;
  body.appendChild(opts);
  opts.querySelector('#secShowPlane').addEventListener('change', (e) => {
    viewer.showSectionPlane = e.target.checked;
    viewer.updateClipping();
  });
  opts.querySelector('#secReset').addEventListener('click', () => {
    for (const a of 'xyz') Object.assign(viewer.sections[a], { on: false, pos: 0.5, flip: false });
    viewer.updateClipping();
    renderSectionPanel();
  });
}

// ---- explode
$('explodeRange').addEventListener('input', (e) => {
  const v = e.target.value / 100;
  $('explodeVal').textContent = `${e.target.value}%`;
  viewer.setExplode(v);
});
$('btnMove').addEventListener('click', () => startMove('translate'));
$('btnRotate').addEventListener('click', () => startMove('rotate'));
$('btnResetPos').addEventListener('click', () => {
  viewer.resetPositions();
  $('explodeRange').value = 0;
  $('explodeVal').textContent = '0%';
});
function startMove(mode) {
  if (viewer.transform.object && viewer.transform.mode === mode) {
    viewer.stopMove();
    $('btnMove').classList.remove('active');
    $('btnRotate').classList.remove('active');
    return;
  }
  if (!viewer.startMove(mode)) {
    toast('먼저 이동할 요소를 선택하세요.');
    return;
  }
  $('btnMove').classList.toggle('active', mode === 'translate');
  $('btnRotate').classList.toggle('active', mode === 'rotate');
  status(mode === 'translate' ? '화살표를 드래그해 요소를 분리하세요. (Esc: 종료)' : '링을 드래그해 회전하세요. (Esc: 종료)');
}

// ===================================================================== context menu
function showContextMenu(x, y) {
  const m = $('contextMenu');
  m.innerHTML = '';
  const items = [];
  if (viewer.mode === '3d') {
    const sel = selected();
    const one = sel.length === 1 ? sel[0] : null;
    const mesh = one?.isMesh ? one : null;
    if (sel.length) items.push({ title: sel.length === 1 ? one.name : `${sel.length}개 선택됨` });
    items.push(
      { ic: 'focus', label: '선택 확대', dis: !sel.length, act: () => viewer.fit(true, sel) },
      { ic: 'eyeOff', label: '숨기기', kbd: 'H', dis: !sel.length, act: hideSelection },
      { ic: 'isolate', label: '이것만 보기', kbd: 'I', dis: !sel.length, act: isolateSelection },
      { ic: 'showAll', label: '모두 보기', kbd: 'A', act: () => viewer.showAll() },
      '-',
      { ic: 'move', label: '분리 이동', kbd: 'T', dis: !one, act: () => { showExplodePanel(); startMove('translate'); } },
      { ic: 'rotate', label: '회전', dis: !one, act: () => { showExplodePanel(); startMove('rotate'); } },
      { ic: 'split', label: '연결 요소로 분할', dis: !mesh, act: () => splitSelected('connect') },
      { ic: 'split', label: '면(Face) 단위 분할', dis: !(mesh?.userData.brepFaces?.length > 1), act: () => splitSelected('faces') },
      { ic: 'reset', label: '모든 위치 원래대로', act: () => $('btnResetPos').click() },
      '-',
      { ic: 'palette', label: '색상 변경...', dis: !sel.length, act: pickColor },
      { ic: 'reset', label: '색상 원래대로', dis: !sel.length, act: () => viewer.resetPartColor(sel) },
      { ic: 'xray', label: '반투명 토글', dis: !sel.length, act: () => viewer.setPartOpacity(sel, (sel[0].userData.opacity ?? (firstMesh(sel[0])?.userData.opacity ?? 1)) < 1 ? 1 : 0.3) },
      '-',
      { ic: 'download', label: '선택 내보내기 (STL)', dis: !sel.length, act: () => exportSelection('stl') },
      { ic: 'download', label: '선택 내보내기 (GLB)', dis: !sel.length, act: () => exportSelection('glb') },
      { ic: 'download', label: '전체 내보내기 (GLB)', act: () => exportSelection('glb', true) },
    );
  } else if (viewer.mode === '2d') {
    const ids = [...(viewer.entitySel?.keys() || [])];
    if (ids.length) items.push({ title: ids.length === 1 ? `${viewer.cad.entities[ids[0]].type} · ${viewer.cad.entities[ids[0]].layer}` : `${ids.length}개 선택됨` });
    items.push(
      { ic: 'focus', label: '선택 확대', dis: !ids.length, act: () => fitEntities(ids) },
      { ic: 'eyeOff', label: '선택 객체의 레이어 끄기', dis: !ids.length, act: hideSelection },
      { ic: 'isolate', label: '선택 객체의 레이어만 보기', dis: !ids.length, act: () => isolateLayers(ids) },
      { ic: 'showAll', label: '모든 레이어 켜기', act: () => { viewer.showAll(); layers.refresh(); } },
      '-',
      { ic: 'fit', label: '전체 보기', kbd: 'F', act: () => viewer.fit(true) },
    );
  } else return;

  for (const it of items) {
    if (it === '-') { m.appendChild(document.createElement('hr')); continue; }
    if (it.title) {
      const t = document.createElement('div');
      t.className = 'cm-title';
      t.textContent = it.title;
      m.appendChild(t);
      continue;
    }
    const b = document.createElement('button');
    b.innerHTML = `${icon(it.ic === 'xray' ? 'eye' : it.ic, 15)}<span>${it.label}</span>${it.kbd ? `<span class="kbd" style="margin-left:auto;color:var(--muted);font-size:11px">${it.kbd}</span>` : ''}`;
    b.disabled = !!it.dis;
    b.addEventListener('click', () => { m.classList.add('hidden'); it.act(); });
    m.appendChild(b);
  }
  m.classList.remove('hidden');
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.min(x, window.innerWidth - w - 6) + 'px';
  m.style.top = Math.min(y, window.innerHeight - h - 6) + 'px';
}

function firstMesh(o) {
  let r = null;
  o.traverse((c) => { if (!r && c.isMesh && c.name !== '__edges') r = c; });
  return r;
}

function showExplodePanel() {
  $('explodePanel').classList.remove('hidden');
  updateToolbar();
}

function fitEntities(ids) {
  const box = new THREE.Box3();
  for (const id of ids) box.union(viewer.cad.entityBox(id));
  if (!box.isEmpty()) {
    const s = box.getSize(new THREE.Vector3());
    const pad = Math.max(s.x, s.y, 1e-3) * 0.15;
    box.expandByScalar(pad);
    viewer.fit(true, box);
  }
}

function isolateLayers(ids) {
  const keep = new Set(ids.map((id) => viewer.cad.entities[id].layer));
  for (const l of viewer.cad.layerList()) viewer.cad.setLayerVisible(l.name, keep.has(l.name));
  layers.refresh();
  viewer.requestRender();
}

function pickColor() {
  const sel = selected();
  const inp = document.createElement('input');
  inp.type = 'color';
  const m = firstMesh(sel[0]);
  const mat = Array.isArray(m?.material) ? m.material[0] : m?.material;
  inp.value = '#' + (mat?.color?.getHexString() || 'b8c2cc');
  inp.addEventListener('input', () => viewer.setPartColor(sel, inp.value));
  inp.addEventListener('change', () => renderProps());
  inp.click();
}

function splitSelected(kind) {
  const mesh = selected()[0];
  if (!mesh?.isMesh) return;
  setLoading('요소 분할 중...');
  setTimeout(() => {
    try {
      const group = kind === 'faces' ? splitByBrepFaces(mesh) : splitByConnectivity(mesh);
      if (!group) {
        toast(kind === 'faces' ? '분할할 면이 없습니다.' : '이 메쉬는 하나로 연결되어 있어 분할할 요소가 없습니다.');
        return;
      }
      viewer.clearSelection(true);
      viewer.replaceObject(mesh, group);
      viewer.select([group]);
      status(`${group.children.length}개 요소로 분할했습니다.`);
      toast(`${group.children.length}개 요소로 분할했습니다. 분해 슬라이더 또는 '분리 이동'으로 분리하세요.`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      setLoading(null);
    }
  }, 30);
}

async function exportSelection(fmt, all = false) {
  const src = all ? [viewer.model] : selected();
  if (!src.length) return;
  const group = new THREE.Group();
  for (const o of src) {
    o.updateWorldMatrix(true, true);
    const c = o.clone(true);
    c.traverse((n) => {
      for (const ch of [...n.children]) if (ch.name === '__edges' || ch.userData.helper) n.remove(ch);
      if (n.material) {
        const fix = (m) => {
          const k = m.clone();
          k.clippingPlanes = null;
          if (k.emissive && m.userData.orig?.emissive) k.emissive.copy(m.userData.orig.emissive);
          k.wireframe = false; k.colorWrite = true; k.depthWrite = true;
          k.transparent = m.userData.orig?.transparent ?? false;
          k.opacity = m.userData.orig?.opacity ?? 1;
          return k;
        };
        n.material = Array.isArray(n.material) ? n.material.map(fix) : fix(n.material);
      }
    });
    o.matrixWorld.decompose(c.position, c.quaternion, c.scale);
    group.add(c);
  }
  const base = (all ? state.file?.name : src[0].name || 'part').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_');
  try {
    let blob;
    if (fmt === 'stl') {
      const { STLExporter } = await import('three/examples/jsm/exporters/STLExporter.js');
      const data = new STLExporter().parse(group, { binary: true });
      blob = new Blob([data], { type: 'model/stl' });
    } else {
      const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
      const data = await new GLTFExporter().parseAsync(group, { binary: true });
      blob = new Blob([data], { type: 'model/gltf-binary' });
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${base}.${fmt}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    status(`${a.download} 저장 완료`);
  } catch (err) {
    toast('내보내기 실패: ' + err.message, true);
  } finally {
    disposeObject(group, true);
  }
}

// ===================================================================== properties panel
const fmtN = (n, d = 3) => (n == null || !isFinite(n) ? '-' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(2) + ' MB' : (b / 1024).toFixed(1) + ' KB');

function renderProps() {
  const el = $('propsView');
  const u = measure.unit ? ' ' + measure.unit : '';
  if (viewer.mode === 'empty') {
    el.innerHTML = '<div class="empty-props">파일을 열면 모델 정보가 표시됩니다.</div>';
    $('statusSel').textContent = '';
    return;
  }
  const rows = [];
  const sect = (t) => rows.push(`<tr class="sect"><th colspan="2">${t}</th></tr>`);
  const row = (k, v, raw = false) => rows.push(`<tr><th>${esc(k)}</th><td>${raw ? v : esc(v)}</td></tr>`);

  if (viewer.mode === '2d') {
    const ids = [...(viewer.entitySel?.keys() || [])];
    const cad = viewer.cad;
    if (ids.length === 1) {
      const e = cad.entities[ids[0]];
      sect('객체');
      row('종류', e.type);
      row('레이어', e.layer);
      if (e.handle != null) row('핸들', e.handle);
      row('색상', e.color == null ? 'BYLAYER' : e.color === -1 ? 'BYBLOCK' : `<span class="swatch" style="display:inline-block;vertical-align:middle;background:#${e.color.toString(16).padStart(6, '0')}"></span> #${e.color.toString(16).padStart(6, '0')}`, e.color != null && e.color !== -1);
      for (const [k, v] of Object.entries(e.info || {})) if (v !== undefined && v !== '') row(k, typeof v === 'number' ? fmtN(v) : typeof v === 'boolean' ? (v ? '예' : '아니오') : v);
      const box = cad.entityBox(ids[0]);
      if (!box.isEmpty()) {
        const s = box.getSize(new THREE.Vector3());
        row('범위 (W × H)', `${fmtN(s.x)} × ${fmtN(s.y)}${u}`);
      }
    } else if (ids.length > 1) {
      sect(`${ids.length}개 객체 선택`);
      const byType = {};
      for (const id of ids) byType[cad.entities[id].type] = (byType[cad.entities[id].type] || 0) + 1;
      for (const [k, v] of Object.entries(byType)) row(k, v);
    }
    const d = state.drawing;
    sect('도면 정보');
    row('파일', state.file?.name);
    row('형식', `${d.format}${d.version ? ' (' + d.version + ')' : ''}`);
    row('크기', fmtSize(state.fileSize));
    row('객체 수', fmtN(cad.entities.length, 0));
    row('레이어 수', fmtN(cad.layerList().length, 0));
    row('블록 수', fmtN(Object.keys(d.blocks).length, 0));
    if (measure.unit) row('단위', measure.unit);
    const s = viewer.sceneBox.getSize(new THREE.Vector3());
    row('도면 범위', `${fmtN(s.x)} × ${fmtN(s.y)}${u}`);
    const top = Object.entries(d.stats).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (top.length) {
      sect('객체 종류');
      for (const [k, v] of top) row(k, fmtN(v, 0));
    }
    $('statusSel').textContent = ids.length ? `${ids.length}개 선택` : '';
    el.innerHTML = `<table class="props">${rows.join('')}</table>`;
    return;
  }

  const sel = selected();
  let actions = '';
  if (sel.length === 1) {
    const o = sel[0];
    const st = meshStats(o);
    const size = st.box.getSize(new THREE.Vector3());
    const c = st.box.getCenter(new THREE.Vector3());
    sect('선택 요소');
    row('이름', o.name);
    row('종류', o.isMesh ? '바디 (메쉬)' : o.isPoints ? '점군' : `그룹 (${o.children.filter((k) => k.name !== '__edges').length}개 하위)`);
    const path = [];
    let p = o.parent;
    while (p && p !== viewer.root) { path.unshift(p.name); p = p.parent; }
    if (path.length) row('경로', path.join(' / '));
    sect('형상');
    row('크기 (X×Y×Z)', `${fmtN(size.x)} × ${fmtN(size.y)} × ${fmtN(size.z)}${u}`);
    row('중심', `${fmtN(c.x)}, ${fmtN(c.y)}, ${fmtN(c.z)}`);
    if (st.meshes) {
      row('표면적', `${fmtN(st.area)}${u ? u + '²' : ''}`);
      row('부피 (근사)', `${fmtN(st.volume)}${u ? u + '³' : ''}`);
      row('바디 수', fmtN(st.meshes, 0));
      row('삼각형', fmtN(st.tris, 0));
      row('정점', fmtN(st.verts, 0));
    }
    if (o.isMesh && o.userData.brepFaces?.length) row('B-rep 면 수', fmtN(o.userData.brepFaces.length, 0));
    const m = firstMesh(o);
    const mat = m && (Array.isArray(m.material) ? m.material[0] : m.material);
    if (mat?.color) {
      sect('표시');
      row('색상', `<input type="color" id="propColor" value="#${mat.vertexColors ? 'ffffff' : mat.color.getHexString()}"/>`, true);
      const op = m.userData.opacity ?? 1;
      row('불투명도', `<input type="range" id="propOpacity" min="5" max="100" value="${Math.round(op * 100)}"/>`, true);
    }
    actions = `<div class="prop-actions">
      <button class="btn sm" data-pa="fit">${icon('focus', 14)} 확대</button>
      <button class="btn sm" data-pa="isolate">${icon('isolate', 14)} 이것만</button>
      <button class="btn sm" data-pa="hide">${icon('eyeOff', 14)} 숨기기</button>
      <button class="btn sm" data-pa="move">${icon('move', 14)} 분리 이동</button>
      ${o.isMesh ? `<button class="btn sm" data-pa="split">${icon('split', 14)} 요소 분할</button>` : ''}
    </div>`;
  } else if (sel.length > 1) {
    sect(`${sel.length}개 요소 선택`);
    let tris = 0;
    const box = new THREE.Box3();
    for (const o of sel) {
      const st = meshStats(o);
      tris += st.tris;
      box.union(st.box);
    }
    const s = box.getSize(new THREE.Vector3());
    row('전체 크기', `${fmtN(s.x)} × ${fmtN(s.y)} × ${fmtN(s.z)}${u}`);
    row('삼각형', fmtN(tris, 0));
    actions = `<div class="prop-actions"><button class="btn sm" data-pa="fit">확대</button><button class="btn sm" data-pa="isolate">이것만</button><button class="btn sm" data-pa="hide">숨기기</button></div>`;
  }

  // model summary
  if (!modelSummaryCache || modelSummaryCache.model !== viewer.model || modelSummaryCache.parts !== viewer.parts.length) {
    modelSummaryCache = { model: viewer.model, parts: viewer.parts.length, st: meshStats(viewer.model) };
  }
  const st = modelSummaryCache.st;
  const size = st.box.getSize(new THREE.Vector3());
  sect('모델 정보');
  row('파일', state.file?.name);
  row('형식', state.format?.label);
  row('크기', fmtSize(state.fileSize));
  row('부품 수', fmtN(viewer.parts.length, 0));
  row('삼각형', fmtN(st.tris, 0));
  row('전체 크기', `${fmtN(size.x)} × ${fmtN(size.y)} × ${fmtN(size.z)}${u}`);

  el.innerHTML = actions + `<table class="props">${rows.join('')}</table>`;
  $('statusSel').textContent = sel.length ? `${sel.length}개 선택` : '';

  el.querySelectorAll('[data-pa]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.pa;
    if (a === 'fit') viewer.fit(true, sel);
    else if (a === 'isolate') isolateSelection();
    else if (a === 'hide') hideSelection();
    else if (a === 'move') { showExplodePanel(); startMove('translate'); }
    else if (a === 'split') splitSelected(sel[0].userData.brepFaces?.length > 1 ? 'faces' : 'connect');
  }));
  $('propColor')?.addEventListener('input', (e) => viewer.setPartColor(sel, e.target.value));
  $('propOpacity')?.addEventListener('input', (e) => viewer.setPartOpacity(sel, e.target.value / 100));
}
let modelSummaryCache = null;

// ===================================================================== keyboard
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'o') { e.preventDefault(); $('fileInput').click(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === 'escape') {
    closeMenu();
    $('contextMenu').classList.add('hidden');
    $('helpModal').classList.add('hidden');
    if (measure.points.length) return measure.cancel();
    if (measure.mode) { measure.setMode(null); syncMeasureModes(); return; }
    if (viewer.transform.object) { viewer.stopMove(); $('btnMove').classList.remove('active'); $('btnRotate').classList.remove('active'); return; }
    viewer.clearSelection();
    viewer.clearEntitySelection();
    return;
  }
  if (k === 'enter' && measure.mode) return measure.complete();
  if (k === '?' || k === 'f1') { e.preventDefault(); return showHelp(); }
  if (viewer.mode === 'empty') return;
  const viewKeys = { 1: 'front', 2: 'back', 3: 'left', 4: 'right', 5: 'top', 6: 'bottom', 7: 'iso' };
  if (viewKeys[k] && viewer.mode === '3d') return viewer.setView(viewKeys[k]);
  switch (k) {
    case 'f': viewer.selection.size ? viewer.fit(true, selected()) : viewer.entitySel?.size ? fitEntities([...viewer.entitySel.keys()]) : viewer.fit(true); break;
    case 'h': case 'delete': hideSelection(); break;
    case 'i': if (viewer.mode === '3d') isolateSelection(); break;
    case 'a': viewer.showAll(); layers.refresh(); break;
    case 'm': togglePanel('measurePanel'); break;
    case 's': if (viewer.mode === '3d') togglePanel('sectionPanel'); break;
    case 'e': if (viewer.mode === '3d') togglePanel('explodePanel'); break;
    case 't': if (viewer.mode === '3d') { showExplodePanel(); startMove('translate'); } break;
    case 'r': if (viewer.mode === '3d' && viewer.transform.object) startMove('rotate'); break;
    case 'p': if (viewer.mode === '3d') toggleProjection(); break;
    case 'g': if (viewer.mode === '3d') toggleGrid(); break;
    case 'w': if (viewer.mode === '3d') setRenderMode(viewer.renderMode === 'wireframe' ? 'shaded-edges' : 'wireframe'); break;
    case 'x': if (viewer.mode === '3d') setRenderMode(viewer.renderMode === 'xray' ? 'shaded-edges' : 'xray'); break;
    default: break;
  }
});

// ===================================================================== help
function showHelp() {
  const m = $('helpModal');
  m.innerHTML = `<div class="modal-card">
    <header>도움말 <button class="icon-btn" id="helpClose">${icon('close', 16)}</button></header>
    <div class="content">
      <div>
        <h4>마우스</h4>
        <table>
          <tr><td>회전 (3D)</td><td>왼쪽 드래그</td></tr>
          <tr><td>이동 (Pan)</td><td>오른쪽 / 가운데 드래그 (2D: 왼쪽 드래그)</td></tr>
          <tr><td>확대 / 축소</td><td>휠 (커서 위치 기준)</td></tr>
          <tr><td>선택</td><td>클릭 · <kbd>Ctrl</kbd>/<kbd>Shift</kbd>+클릭: 다중 선택</td></tr>
          <tr><td>회전 중심 지정</td><td>더블클릭 (빈 곳: 전체 보기)</td></tr>
          <tr><td>메뉴</td><td>오른쪽 클릭</td></tr>
          <tr><td>표준 뷰</td><td>우상단 뷰 큐브의 면/모서리 클릭</td></tr>
        </table>
        <h4 style="margin-top:14px">지원 형식</h4>
        <table>
          <tr><td>B-rep CAD</td><td>STEP, STP, IGES, IGS, BREP</td></tr>
          <tr><td>메쉬</td><td>STL, OBJ(+MTL), glTF, GLB, FBX, PLY, 3MF, DAE, 3DS, AMF, VRML, VTK</td></tr>
          <tr><td>점군</td><td>XYZ, PCD, PLY</td></tr>
          <tr><td>2D 도면</td><td>DWG (R13~2018+), DXF (ASCII)</td></tr>
        </table>
      </div>
      <div>
        <h4>단축키</h4>
        <table>
          <tr><td><kbd>F</kbd></td><td>전체 / 선택 확대</td></tr>
          <tr><td><kbd>1</kbd>~<kbd>7</kbd></td><td>정면·배면·좌·우·평면·저면·등각</td></tr>
          <tr><td><kbd>P</kbd></td><td>원근 / 직교 투영</td></tr>
          <tr><td><kbd>W</kbd> / <kbd>X</kbd></td><td>와이어프레임 / X-Ray</td></tr>
          <tr><td><kbd>G</kbd></td><td>그리드</td></tr>
          <tr><td><kbd>H</kbd> / <kbd>Del</kbd></td><td>선택 숨기기</td></tr>
          <tr><td><kbd>I</kbd></td><td>선택만 보기</td></tr>
          <tr><td><kbd>A</kbd></td><td>모두 보기</td></tr>
          <tr><td><kbd>M</kbd></td><td>측정</td></tr>
          <tr><td><kbd>S</kbd></td><td>단면</td></tr>
          <tr><td><kbd>E</kbd></td><td>분해 패널</td></tr>
          <tr><td><kbd>T</kbd> / <kbd>R</kbd></td><td>선택 요소 이동 / 회전 (분리)</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>취소 / 선택 해제</td></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>O</kbd></td><td>파일 열기</td></tr>
        </table>
      </div>
    </div></div>`;
  m.classList.remove('hidden');
  m.onclick = (e) => { if (e.target === m || e.target.closest('#helpClose')) m.classList.add('hidden'); };
}

// ===================================================================== misc
let statusTimer = 0;
function status(msg) {
  $('statusMsg').textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => ($('statusMsg').textContent = '준비'), 8000);
}
function toast(msg, error = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (error ? ' error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), error ? 6000 : 3500);
}

try {
  const bg = localStorage.getItem('w3v.bg');
  if (bg && BGS[bg]) state.bg = bg;
} catch { /* ignore */ }
setBackground(state.bg);
// narrow screens: start with the side panels closed so the viewport is usable
if (window.innerWidth < 720) togglePanelSide('left');
if (window.innerWidth < 1000) togglePanelSide('right');
renderProps();
updateToolbar();

// open ?url=... (CORS permitting)
const qp = new URLSearchParams(location.search).get('url');
if (qp) openUrl(qp);

// expose for debugging
window.__viewer = viewer;
export { viewer, VIEWS, formatOf };
