// DXF / DWG -> three.js scene (merged per layer for performance)
import * as THREE from 'three';
import { WorkerClient } from './workerClient.js';

const client = new WorkerClient(() => new Worker(new URL('../workers/cad.worker.js', import.meta.url), { type: 'module' }));

const MAX_TEXTS = 40000;
const MAX_DEPTH = 24;

export async function loadCad2D(format, buffer, onProgress) {
  onProgress(format === 'dwg' ? 'DWG 해석 중... (LibreDWG 엔진 로딩)' : 'DXF 해석 중...');
  const { drawing } = await client.call({ format, buffer }, [buffer]);
  onProgress('도면 생성 중...');
  await new Promise((r) => setTimeout(r, 0));
  const cad = new CadDrawing(drawing);
  return { object: cad.group, drawing, cad };
}

function txf(M, x, y, z) {
  if (!M) return [x, y, z];
  return [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]];
}

function mul(a, b) {
  if (!a) return b;
  const r = new Array(16);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
      r[i * 4 + j] = s;
    }
  return r;
}

class Bucket {
  constructor(name) {
    this.name = name;
    this.lines = []; this.lineCol = []; this.segEnt = [];
    this.tris = []; this.triCol = []; this.triEnt = [];
    this.trisT = []; this.triTCol = []; this.triTEnt = [];
    this.pts = []; this.ptCol = []; this.ptEnt = [];
    this.texts = [];
  }
}

export class CadDrawing {
  constructor(drawing) {
    this.drawing = drawing;
    this.layers = new Map();
    for (const [name, l] of Object.entries(drawing.layers)) this.layers.set(name, { name, color: l.color ?? 0xffffff, visible: l.visible && !l.frozen, count: 0 });
    this.entities = []; // top-level entity records
    this.buckets = new Map();
    this.textCount = 0;
    this.skippedTexts = 0;
    this.light = false;
    this.build();
  }

  layer(name) {
    let l = this.layers.get(name);
    if (!l) {
      l = { name, color: 0xffffff, visible: true, count: 0 };
      this.layers.set(name, l);
    }
    return l;
  }

  bucket(name) {
    let b = this.buckets.get(name);
    if (!b) this.buckets.set(name, (b = new Bucket(name)));
    return b;
  }

  build() {
    const d = this.drawing;
    d.entities.forEach((ent) => {
      const rec = { id: this.entities.length, type: ent.type, layer: ent.layer, handle: ent.handle, color: ent.color, info: ent.info || {}, ranges: [] };
      this.entities.push(rec);
      this.layer(ent.layer).count++;
      this.emit(ent, null, null, rec, 0, []);
    });
    this.makeObjects();
  }

  resolveColor(ent, effLayer, ctx) {
    if (ent.color == null) return this.layer(effLayer).color;
    if (ent.color === -1) return ctx?.color ?? this.layer(effLayer).color;
    return ent.color;
  }

  emit(ent, M, ctx, rec, depth, stack) {
    const effLayer = ent.layer === '0' && ctx?.layer ? ctx.layer : ent.layer;
    const color = this.resolveColor(ent, effLayer, ctx);
    const b = this.bucket(effLayer);

    if (ent.kind === 'insert') {
      const blk = this.drawing.blocks[ent.name];
      if (!blk || depth >= MAX_DEPTH || stack.includes(ent.name)) return;
      const off = blk.offset || [0, 0, 0];
      const M2 = mul(mul(M, ent.m), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, off[0], off[1], off[2], 1]);
      const nctx = { layer: effLayer, color };
      stack.push(ent.name);
      for (const child of blk.entities) this.emit(child, M2, nctx, rec, depth + 1, stack);
      stack.pop();
      return;
    }

    if (ent.polys) {
      const start = b.segEnt.length;
      for (const f of ent.polys) {
        for (let i = 3; i < f.length; i += 3) {
          const p = txf(M, f[i - 3], f[i - 2], f[i - 1]);
          const q = txf(M, f[i], f[i + 1], f[i + 2]);
          b.lines.push(p[0], p[1], p[2], q[0], q[1], q[2]);
          b.lineCol.push(color, color);
          b.segEnt.push(rec.id);
        }
      }
      const n = b.segEnt.length - start;
      if (n) rec.ranges.push({ layer: effLayer, kind: 'seg', start, count: n });
    }
    if (ent.tris && ent.tris.length) {
      const translucent = (ent.alpha ?? 1) < 1;
      const T = translucent ? b.trisT : b.tris;
      const C = translucent ? b.triTCol : b.triCol;
      const E = translucent ? b.triTEnt : b.triEnt;
      const start = E.length;
      const f = ent.tris;
      for (let i = 0; i < f.length; i += 9) {
        for (let k = 0; k < 9; k += 3) {
          const p = txf(M, f[i + k], f[i + k + 1], f[i + k + 2]);
          T.push(p[0], p[1], p[2]);
          C.push(color);
        }
        E.push(rec.id);
      }
      rec.ranges.push({ layer: effLayer, kind: translucent ? 'triT' : 'tri', start, count: E.length - start });
    }
    if (ent.kind === 'point') {
      const p = txf(M, ...ent.p);
      b.pts.push(...p);
      b.ptCol.push(color);
      b.ptEnt.push(rec.id);
    }
    if (ent.kind === 'text') {
      if (this.textCount >= MAX_TEXTS) { this.skippedTexts++; return; }
      this.textCount++;
      // text frame: M * T(p) * Rz(rot) * S(wf, 1, 1)
      const c = Math.cos(ent.rot || 0), s = Math.sin(ent.rot || 0), wf = ent.wf || 1;
      const local = [c * wf, s * wf, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, ent.p[0], ent.p[1], ent.p[2], 1];
      b.texts.push({ m: mul(M, local), text: ent.text, h: ent.h, ha: ent.ha || 0, va: ent.va || 0, mtext: !!ent.mtext, color, entId: rec.id });
    }
  }

  makeObjects() {
    // drawing extents -> origin shift (keeps float32 precision for far-away coordinates)
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const b of this.buckets.values()) {
      for (const arr of [b.lines, b.tris, b.trisT, b.pts])
        for (let i = 0; i < arr.length; i += 3) box.expandByPoint(v.set(arr[i], arr[i + 1], arr[i + 2]));
      for (const t of b.texts) box.expandByPoint(v.set(t.m[12], t.m[13], t.m[14]));
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, 0), new THREE.Vector3(1, 1, 0));
    const c = box.getCenter(new THREE.Vector3());
    const mag = Math.max(Math.abs(c.x), Math.abs(c.y), 1);
    const step = Math.pow(10, Math.floor(Math.log10(mag)) - 1);
    this.origin = new THREE.Vector3(Math.round(c.x / step) * step, Math.round(c.y / step) * step, 0);
    if (Math.abs(c.x) < 1e4 && Math.abs(c.y) < 1e4) this.origin.set(0, 0, 0);

    const O = this.origin;
    const group = new THREE.Group();
    group.name = 'Drawing';
    group.userData.isCad = true;
    group.userData.cadOrigin = O.clone();
    this.group = group;
    this.layerGroups = new Map();

    const lineMat = new THREE.LineBasicMaterial({ vertexColors: true });
    const fillMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const fillTMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.18, depthWrite: false });
    const ptMat = new THREE.PointsMaterial({ vertexColors: true, size: 4, sizeAttenuation: false });
    this.materials = { lineMat, fillMat, fillTMat, ptMat };

    const toPos = (arr) => {
      const out = new Float32Array(arr.length);
      for (let i = 0; i < arr.length; i += 3) {
        out[i] = arr[i] - O.x; out[i + 1] = arr[i + 1] - O.y; out[i + 2] = arr[i + 2] - O.z;
      }
      return out;
    };
    const toCol = (ints) => {
      const out = new Float32Array(ints.length * 3);
      const white = new Uint8Array(ints.length);
      for (let i = 0; i < ints.length; i++) {
        const n = ints[i];
        out[i * 3] = ((n >> 16) & 255) / 255; out[i * 3 + 1] = ((n >> 8) & 255) / 255; out[i * 3 + 2] = (n & 255) / 255;
        if ((n & 0xffffff) === 0xffffff) white[i] = 1;
      }
      return { out, white };
    };
    const geom = (pos, colInts) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(toPos(pos), 3));
      const { out, white } = toCol(colInts);
      g.setAttribute('color', new THREE.BufferAttribute(out, 3));
      g.userData.white = white;
      g.computeBoundingBox();
      g.computeBoundingSphere();
      return g;
    };

    const names = [...this.buckets.keys()].sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const b = this.buckets.get(name);
      const lg = new THREE.Group();
      lg.name = name;
      lg.userData.layer = name;
      lg.visible = this.layer(name).visible;
      if (b.lines.length) {
        const ls = new THREE.LineSegments(geom(b.lines, b.lineCol), lineMat);
        ls.userData.segEnt = Int32Array.from(b.segEnt);
        ls.userData.cadKind = 'seg';
        ls.name = name + ' (선)';
        lg.add(ls);
      }
      if (b.tris.length) {
        const m = new THREE.Mesh(geom(b.tris, b.triCol), fillMat);
        m.userData.triEnt = Int32Array.from(b.triEnt);
        m.userData.cadKind = 'tri';
        m.renderOrder = -1;
        lg.add(m);
      }
      if (b.trisT.length) {
        const m = new THREE.Mesh(geom(b.trisT, b.triTCol), fillTMat);
        m.userData.triEnt = Int32Array.from(b.triTEnt);
        m.userData.cadKind = 'triT';
        m.renderOrder = -2;
        lg.add(m);
      }
      if (b.pts.length) {
        const p = new THREE.Points(geom(b.pts, b.ptCol), ptMat);
        p.userData.ptEnt = Int32Array.from(b.ptEnt);
        p.userData.cadKind = 'pt';
        lg.add(p);
      }
      if (b.texts.length) {
        const tg = new THREE.Group();
        tg.name = name + ' (문자)';
        for (const t of b.texts) tg.add(makeText(t, O));
        lg.add(tg);
      }
      group.add(lg);
      this.layerGroups.set(name, lg);
    }
    // free intermediate arrays
    this.buckets.clear();
  }

  layerList() {
    return [...this.layers.values()]
      .filter((l) => this.layerGroups.has(l.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  setLayerVisible(name, visible) {
    const l = this.layers.get(name);
    if (l) l.visible = visible;
    const g = this.layerGroups.get(name);
    if (g) g.visible = visible;
  }

  /** maps a raycast intersection to a top-level entity id */
  entityFromHit(hit) {
    const o = hit.object;
    if (o.userData.entId != null) return o.userData.entId;
    if (o.userData.segEnt) return o.userData.segEnt[Math.floor(hit.index / 2)];
    if (o.userData.triEnt) return o.userData.triEnt[hit.faceIndex];
    if (o.userData.ptEnt) return o.userData.ptEnt[hit.index];
    return null;
  }

  /** highlight overlay for one entity */
  buildHighlight(id, colorHex = 0x4da3ff) {
    const rec = this.entities[id];
    if (!rec) return null;
    const g = new THREE.Group();
    g.name = '__highlight';
    const color = new THREE.Color(colorHex);
    for (const r of rec.ranges) {
      const lg = this.layerGroups.get(r.layer);
      if (!lg) continue;
      const src = lg.children.find((c) => c.userData.cadKind === r.kind);
      if (!src) continue;
      const pos = src.geometry.attributes.position.array;
      const per = r.kind === 'seg' ? 6 : 9;
      const slice = pos.slice(r.start * per, (r.start + r.count) * per);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(slice, 3));
      const obj = r.kind === 'seg'
        ? new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: 2 }))
        : new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
      obj.renderOrder = 999;
      g.add(obj);
    }
    // texts
    this.group.traverse((o) => {
      if (o.userData.entId === id && o.isMesh) {
        const box = new THREE.Box3Helper(new THREE.Box3().setFromObject(o), color);
        box.material.depthTest = false;
        box.renderOrder = 999;
        g.add(box);
      }
    });
    return g;
  }

  entityBox(id) {
    const rec = this.entities[id];
    const box = new THREE.Box3();
    if (!rec) return box;
    const v = new THREE.Vector3();
    for (const r of rec.ranges) {
      const lg = this.layerGroups.get(r.layer);
      const src = lg?.children.find((c) => c.userData.cadKind === r.kind);
      if (!src) continue;
      const pos = src.geometry.attributes.position.array;
      const per = r.kind === 'seg' ? 6 : 9;
      for (let i = r.start * per; i < (r.start + r.count) * per; i += 3) box.expandByPoint(v.set(pos[i], pos[i + 1], pos[i + 2]));
    }
    this.group.traverse((o) => {
      if (o.userData.entId === id && o.isMesh) box.union(new THREE.Box3().setFromObject(o));
    });
    return box;
  }

  /** swaps pure white <-> black depending on viewport background */
  setLightBackground(light) {
    if (this.light === light) return;
    this.light = light;
    const fg = light ? 0 : 1;
    this.group.traverse((o) => {
      const g = o.geometry;
      if (g?.userData.white && g.attributes.color) {
        const c = g.attributes.color.array, w = g.userData.white;
        for (let i = 0; i < w.length; i++) if (w[i]) c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = fg;
        g.attributes.color.needsUpdate = true;
      }
      if (o.userData.isText && o.userData.white) o.material.color.setScalar(fg);
    });
  }
}

// ------------------------------------------------------------------ text
const FONT_PX = 64;
const CAP = 0.72; // cap height / font size
const FONT = `${FONT_PX}px "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", Arial, sans-serif`;
const texCache = new Map();
const unitPlane = new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0);
let measureCtx = null;

function textTexture(text) {
  let t = texCache.get(text);
  if (t) return t;
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = FONT;
  const lines = text.split('\n');
  const widths = lines.map((l) => measureCtx.measureText(l).width);
  const lineH = FONT_PX * 1.25;
  const pad = 4;
  const asc = FONT_PX * 0.92, desc = FONT_PX * 0.28;
  const w = Math.max(4, Math.ceil(Math.max(...widths)) + pad * 2);
  const h = Math.ceil(pad * 2 + asc + desc + (lines.length - 1) * lineH);
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(4096, w);
  canvas.height = Math.min(4096, h);
  const ctx = canvas.getContext('2d');
  ctx.font = FONT;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  lines.forEach((l, i) => ctx.fillText(l, pad, pad + asc + i * lineH));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  t = { tex, w, h, pad, asc, lineH, lines: lines.length, textW: Math.max(...widths) };
  texCache.set(text, t);
  return t;
}

function makeText(t, O) {
  const tt = textTexture(t.text);
  const s = t.h / (FONT_PX * CAP); // drawing units per pixel
  // plane in pixel space: x from -pad, baseline at 0
  const W = tt.w * s, H = tt.h * s;
  const x0 = -tt.pad * s;
  const top = (tt.pad + tt.asc) * s; // canvas top above first baseline
  let dx = 0, dy = 0;
  const textW = tt.textW * s;
  if (t.ha === 1) dx = -textW / 2;
  else if (t.ha === 2) dx = -textW;
  const capH = t.h;
  const extra = (tt.lines - 1) * tt.lineH * s;
  if (t.va === 3) dy = -capH;
  else if (t.va === 2) dy = -(capH - extra) / 2;
  else if (t.va === 1) dy = t.mtext ? extra : FONT_PX * 0.2 * s;

  // own material per text: colour is changed for theme swaps
  const mat = new THREE.MeshBasicMaterial({ map: tt.tex, color: t.color, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(unitPlane, mat);
  const local = new THREE.Matrix4().makeTranslation(x0 + dx, top - H + dy, 0).multiply(new THREE.Matrix4().makeScale(W, H, 1));
  const M = new THREE.Matrix4().fromArray(t.m);
  M.elements[12] -= O.x; M.elements[13] -= O.y; M.elements[14] -= O.z;
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(M.multiply(local));
  mesh.userData.entId = t.entId;
  mesh.userData.isText = true;
  mesh.userData.white = (t.color & 0xffffff) === 0xffffff;
  mesh.renderOrder = 1;
  return mesh;
}
