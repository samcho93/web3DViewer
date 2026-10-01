// Model structure tree (lazy rendering) and CAD layer list
import { icon } from './icons.js';

const childrenOf = (o) => o.children.filter((c) => c.name !== '__edges' && !c.userData.helper && !c.isCSS2DObject && (c.isMesh || c.isGroup || c.isObject3D) && !c.isLight && !c.isCamera);

export class ModelTree {
  constructor(el, viewer, { onSelect, onFocus, onContext }) {
    this.el = el;
    this.viewer = viewer;
    this.onSelect = onSelect;
    this.onFocus = onFocus;
    this.onContext = onContext;
    this.rows = new Map(); // uid -> row element
    this.filter = '';
  }

  build(root) {
    this.root = root;
    this.rows.clear();
    this.el.innerHTML = '';
    if (!root) return;
    const tree = document.createElement('div');
    tree.className = 'tree';
    this.el.appendChild(tree);
    if (this.filter) this.renderFiltered(tree);
    else tree.appendChild(this.node(root, 0, true));
    this.syncSelection();
  }

  node(obj, depth, open = false) {
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'tn-row';
    row.style.paddingLeft = 4 + depth * 14 + 'px';
    const kids = childrenOf(obj);
    const color = swatchColor(obj);
    row.innerHTML = `<span class="tn-tog ${kids.length ? '' : 'leaf'} ${open ? 'open' : ''}">${icon('chevron', 12)}</span>`
      + `<button class="tn-eye" title="표시/숨기기">${icon(obj.visible ? 'eye' : 'eyeOff', 15)}</button>`
      + (kids.length ? '<span class="tn-type group"></span>' : `<span class="tn-type" style="background:${color}"></span>`)
      + `<span class="tn-name"></span>`
      + (kids.length ? `<span class="tn-count">${kids.length}</span>` : '');
    row.querySelector('.tn-name').textContent = obj.name || '(이름 없음)';
    row.title = obj.name || '';
    row.classList.toggle('hidden-obj', !obj.visible);
    row._obj = obj;
    this.rows.set(obj.userData.uid, row);
    wrap.appendChild(row);

    let childBox = null;
    const ensureChildren = () => {
      if (childBox) return childBox;
      childBox = document.createElement('div');
      childBox.className = 'tn-children';
      const frag = document.createDocumentFragment();
      const MAX = 2000;
      kids.slice(0, MAX).forEach((k) => frag.appendChild(this.node(k, depth + 1)));
      if (kids.length > MAX) {
        const more = document.createElement('div');
        more.className = 'tn-row muted';
        more.style.paddingLeft = 4 + (depth + 1) * 14 + 'px';
        more.textContent = `... 외 ${kids.length - MAX}개`;
        frag.appendChild(more);
      }
      childBox.appendChild(frag);
      wrap.appendChild(childBox);
      return childBox;
    };
    row._expand = (v) => {
      if (!kids.length) return;
      const tog = row.querySelector('.tn-tog');
      const box = ensureChildren();
      const openNow = v ?? box.classList.contains('collapsed');
      box.classList.toggle('collapsed', !openNow);
      tog.classList.toggle('open', openNow);
    };
    if (open && kids.length) ensureChildren();

    row.addEventListener('click', (e) => {
      if (e.target.closest('.tn-tog')) return row._expand();
      if (e.target.closest('.tn-eye')) {
        obj.visible = !obj.visible;
        this.viewer.afterVisibilityChange();
        return;
      }
      this.onSelect(obj, e.ctrlKey || e.metaKey || e.shiftKey);
    });
    row.addEventListener('dblclick', (e) => {
      if (e.target.closest('.tn-eye, .tn-tog')) return;
      this.onFocus(obj);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.viewer.selection.has(obj)) this.onSelect(obj, false);
      this.onContext(e.clientX, e.clientY);
    });
    return wrap;
  }

  renderFiltered(tree) {
    const q = this.filter.toLowerCase();
    let n = 0;
    this.root.traverse((o) => {
      if (n > 3000 || o === this.root || o.name === '__edges' || o.userData.helper) return;
      if ((o.name || '').toLowerCase().includes(q)) {
        tree.appendChild(this.node(o, 0));
        n++;
      }
    });
    if (!n) tree.innerHTML = '<p class="muted" style="padding:10px 12px">일치하는 항목이 없습니다.</p>';
  }

  setFilter(q) {
    this.filter = q.trim();
    this.build(this.root);
  }

  refreshVisibility() {
    for (const row of this.rows.values()) {
      const o = row._obj;
      row.classList.toggle('hidden-obj', !o.visible);
      const eye = row.querySelector('.tn-eye');
      if (eye) eye.innerHTML = icon(o.visible ? 'eye' : 'eyeOff', 15);
    }
  }

  syncSelection() {
    for (const row of this.rows.values()) row.classList.remove('selected');
    let last = null;
    for (const o of this.viewer.selection) {
      // expand ancestors so the row exists
      const chain = [];
      let p = o;
      while (p && p !== this.root) { chain.unshift(p); p = p.parent; }
      if (!this.filter) for (const a of chain.slice(0, -1)) this.rows.get(a.userData.uid)?._expand(true);
      const row = this.rows.get(o.userData.uid);
      if (row) { row.classList.add('selected'); last = row; }
    }
    last?.scrollIntoView({ block: 'nearest' });
  }
}

function swatchColor(o) {
  const m = Array.isArray(o.material) ? o.material[0] : o.material;
  if (!m?.color) return '#8ea2bd';
  if (m.vertexColors) return 'linear-gradient(135deg,#e66,#6c6,#69f)';
  return '#' + m.color.getHexString();
}

export class LayerList {
  constructor(el, viewer, onChange) {
    this.el = el;
    this.viewer = viewer;
    this.onChange = onChange;
  }

  build(cad) {
    this.cad = cad;
    this.el.innerHTML = '';
    if (!cad) {
      this.el.innerHTML = '<p class="muted" style="padding:10px 12px">2D 도면(DWG/DXF)을 열면 레이어 목록이 표시됩니다.</p>';
      return;
    }
    const tools = document.createElement('div');
    tools.className = 'layer-tools';
    tools.innerHTML = '<button class="btn sm" data-a="all">모두 켜기</button><button class="btn sm" data-a="none">모두 끄기</button><button class="btn sm" data-a="inv">반전</button>';
    tools.addEventListener('click', (e) => {
      const a = e.target.dataset.a;
      if (!a) return;
      for (const l of cad.layerList()) cad.setLayerVisible(l.name, a === 'all' ? true : a === 'none' ? false : !l.visible);
      this.refresh();
      this.onChange();
    });
    this.el.appendChild(tools);
    this.list = document.createElement('div');
    this.el.appendChild(this.list);
    this.refresh();
  }

  refresh(filter = this.filterText || '') {
    this.filterText = filter;
    if (!this.cad || !this.list) return;
    this.list.innerHTML = '';
    const q = filter.toLowerCase();
    for (const l of this.cad.layerList()) {
      if (q && !l.name.toLowerCase().includes(q)) continue;
      const row = document.createElement('div');
      row.className = 'layer-row' + (l.visible ? '' : ' off');
      row.innerHTML = `<button class="tn-eye">${icon(l.visible ? 'eye' : 'eyeOff', 15)}</button><span class="swatch" style="background:#${l.color.toString(16).padStart(6, '0')}"></span><span class="layer-name"></span><span class="tn-count">${l.count}</span>`;
      row.querySelector('.layer-name').textContent = l.name;
      row.title = '클릭: 표시/숨기기 · 더블클릭: 이 레이어만 표시';
      row.addEventListener('click', () => {
        this.cad.setLayerVisible(l.name, !l.visible);
        this.refresh();
        this.onChange();
      });
      row.addEventListener('dblclick', () => {
        for (const o of this.cad.layerList()) this.cad.setLayerVisible(o.name, o.name === l.name);
        this.refresh();
        this.onChange();
      });
      this.list.appendChild(row);
    }
  }
}
