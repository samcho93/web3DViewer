// Measurement tool: distance, angle, point coordinates, polygon area.
// Snaps to vertices / segment end- and mid-points.
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

const SNAP_PX = 12;
const COLOR = 0xffb020;

export class MeasureTool extends EventTarget {
  constructor(viewer) {
    super();
    this.viewer = viewer;
    this.mode = null;
    this.points = [];
    this.results = [];
    this.group = new THREE.Group();
    this.group.name = '__measure';
    viewer.overlay.add(this.group);
    this.temp = new THREE.Group();
    this.group.add(this.temp);

    const snapGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    this.snapMarker = new THREE.Points(snapGeo, new THREE.PointsMaterial({ color: 0x00e0ff, size: 11, sizeAttenuation: false, depthTest: false }));
    this.snapMarker.renderOrder = 1000;
    this.snapMarker.visible = false;
    this.group.add(this.snapMarker);
    this.unit = 'mm';
  }

  setMode(mode) {
    this.cancel();
    this.mode = mode;
    this.viewer.container.classList.toggle('measuring', !!mode);
    this.dispatchEvent(new CustomEvent('mode'));
  }

  cancel() {
    this.points = [];
    this.temp.clear();
    this.snapMarker.visible = false;
    this.viewer.requestRender();
  }

  clearAll() {
    this.cancel();
    for (const r of this.results) {
      this.group.remove(r.obj);
      disposeTree(r.obj);
    }
    this.results = [];
    this.dispatchEvent(new CustomEvent('change'));
    this.viewer.requestRender();
  }

  remove(index) {
    const r = this.results[index];
    if (!r) return;
    this.group.remove(r.obj);
    disposeTree(r.obj);
    this.results.splice(index, 1);
    this.dispatchEvent(new CustomEvent('change'));
    this.viewer.requestRender();
  }

  // ------------------------------------------------------------- snapping
  snap(clientX, clientY) {
    const v = this.viewer;
    const hit = v.pick(clientX, clientY, { lines: true });
    const screen = (p) => v.toScreen(p);
    const rect = v.renderer.domElement.getBoundingClientRect();
    const mouse = { x: clientX - rect.left, y: clientY - rect.top };
    const dist = (p) => {
      const s = screen(p);
      return Math.hypot(s.x - mouse.x, s.y - mouse.y);
    };
    if (hit) {
      const o = hit.object;
      const cands = [];
      const pos = o.geometry.attributes.position;
      const w = (i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (o.isLineSegments && hit.index != null) {
        const a = w(hit.index), b = w(hit.index + 1);
        cands.push({ p: a, kind: '끝점' }, { p: b, kind: '끝점' }, { p: a.clone().add(b).multiplyScalar(0.5), kind: '중간점' });
      } else if (o.isMesh && hit.face) {
        const idx = [hit.face.a, hit.face.b, hit.face.c];
        const ps = idx.map(w);
        for (const p of ps) cands.push({ p, kind: '정점' });
        for (let i = 0; i < 3; i++) cands.push({ p: ps[i].clone().add(ps[(i + 1) % 3]).multiplyScalar(0.5), kind: '모서리 중점', weak: true });
      } else if (o.isPoints && hit.index != null) {
        cands.push({ p: w(hit.index), kind: '점' });
      }
      let best = null, bd = SNAP_PX;
      for (const c of cands) {
        const d = dist(c.p) + (c.weak ? 4 : 0);
        if (d < bd) { bd = d; best = c; }
      }
      if (best) return { point: best.p, snapped: best.kind, hit };
      return { point: hit.point.clone(), snapped: null, hit };
    }
    const p = v.pickPlane(clientX, clientY);
    return p ? { point: p, snapped: null, hit: null } : null;
  }

  onMove(clientX, clientY) {
    if (!this.mode) return;
    const s = this.snap(clientX, clientY);
    if (!s) {
      this.snapMarker.visible = false;
      this.viewer.requestRender();
      return;
    }
    this.snapMarker.visible = true;
    this.snapMarker.material.color.set(s.snapped ? 0x00e0ff : 0xffffff);
    this.snapMarker.position.copy(s.point);
    this.cursor = s.point;
    this.drawTemp();
    this.viewer.requestRender();
  }

  onClick(clientX, clientY) {
    if (!this.mode) return false;
    const s = this.snap(clientX, clientY);
    if (!s) return true;
    const p = s.point;
    if (this.mode === 'point') {
      this.finish('point', [p]);
      return true;
    }
    this.points.push(p);
    if (this.mode === 'distance' && this.points.length === 2) this.finish('distance', this.points);
    else if (this.mode === 'angle' && this.points.length === 3) this.finish('angle', this.points);
    else this.drawTemp();
    return true;
  }

  /** for area: close polygon */
  complete() {
    if (this.mode === 'area' && this.points.length >= 3) this.finish('area', this.points);
    else if (this.mode === 'distance' && this.points.length >= 2) this.finish('distance', this.points);
  }

  drawTemp() {
    this.temp.clear();
    const pts = [...this.points];
    if (this.cursor && pts.length) pts.push(this.cursor);
    if (pts.length >= 1) this.temp.add(markers(pts));
    if (pts.length >= 2) this.temp.add(polyline(pts, this.mode === 'area' && pts.length > 2, 0.7));
  }

  // ------------------------------------------------------------- results
  fmt(n) {
    const a = Math.abs(n);
    const d = a >= 1000 ? 1 : a >= 10 ? 2 : 3;
    return n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });
  }

  worldToModel(p) {
    const o = this.viewer.model?.userData.cadOrigin;
    return o ? p.clone().add(o) : p.clone();
  }

  finish(type, pts) {
    pts = pts.map((p) => p.clone());
    const obj = new THREE.Group();
    obj.add(markers(pts));
    let text = '', detail = '';
    const u = this.unit;
    if (type === 'distance') {
      obj.add(polyline(pts, false, 1));
      let total = 0;
      for (let i = 1; i < pts.length; i++) total += pts[i].distanceTo(pts[i - 1]);
      const d = pts[pts.length - 1].clone().sub(pts[0]);
      text = `${this.fmt(total)} ${u}`;
      detail = this.viewer.mode === '2d'
        ? `ΔX ${this.fmt(d.x)} · ΔY ${this.fmt(d.y)}`
        : `ΔX ${this.fmt(d.x)} · ΔY ${this.fmt(d.y)} · ΔZ ${this.fmt(d.z)}`;
      obj.add(label(`${text}`, pts[0].clone().lerp(pts[pts.length - 1], 0.5), detail));
    } else if (type === 'angle') {
      obj.add(polyline(pts, false, 1));
      const a = pts[0].clone().sub(pts[1]).normalize();
      const b = pts[2].clone().sub(pts[1]).normalize();
      const ang = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1)));
      text = `${this.fmt(ang)}°`;
      obj.add(arcGuide(pts[1], a, b, Math.min(pts[0].distanceTo(pts[1]), pts[2].distanceTo(pts[1])) * 0.3));
      obj.add(label(text, pts[1]));
    } else if (type === 'point') {
      const m = this.worldToModel(pts[0]);
      text = this.viewer.mode === '2d' ? `X ${this.fmt(m.x)}, Y ${this.fmt(m.y)}` : `X ${this.fmt(m.x)}, Y ${this.fmt(m.y)}, Z ${this.fmt(m.z)}`;
      obj.add(label(text, pts[0]));
    } else if (type === 'area') {
      obj.add(polyline(pts, true, 1));
      // Newell's method (works for any planar polygon)
      const n = new THREE.Vector3();
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        n.x += (p.y - q.y) * (p.z + q.z);
        n.y += (p.z - q.z) * (p.x + q.x);
        n.z += (p.x - q.x) * (p.y + q.y);
      }
      const area = n.length() / 2;
      let per = 0;
      for (let i = 0; i < pts.length; i++) per += pts[i].distanceTo(pts[(i + 1) % pts.length]);
      text = `${this.fmt(area)} ${u}²`;
      detail = `둘레 ${this.fmt(per)} ${u}`;
      const c = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
      obj.add(label(text, c, detail));
      // translucent fill
      const fill = fillPolygon(pts, n.normalize());
      if (fill) obj.add(fill);
    }
    this.group.add(obj);
    this.results.push({ type, text, detail, obj });
    this.points = [];
    this.temp.clear();
    this.dispatchEvent(new CustomEvent('change'));
    this.viewer.requestRender();
  }
}

function markers(pts) {
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  const m = new THREE.Points(g, new THREE.PointsMaterial({ color: COLOR, size: 8, sizeAttenuation: false, depthTest: false }));
  m.renderOrder = 1000;
  return m;
}

function polyline(pts, closed, opacity) {
  const list = closed ? [...pts, pts[0]] : pts;
  const g = new THREE.BufferGeometry().setFromPoints(list);
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: COLOR, depthTest: false, transparent: opacity < 1, opacity }));
  l.renderOrder = 1000;
  return l;
}

function arcGuide(c, a, b, r) {
  const pts = [];
  const axis = new THREE.Vector3().crossVectors(a, b);
  const ang = a.angleTo(b);
  if (axis.lengthSq() < 1e-12) return new THREE.Group();
  axis.normalize();
  for (let i = 0; i <= 32; i++) pts.push(c.clone().add(a.clone().applyAxisAngle(axis, (ang * i) / 32).multiplyScalar(r)));
  return polyline(pts, false, 0.8);
}

function fillPolygon(pts, normal) {
  if (pts.length < 3) return null;
  // project onto the polygon plane
  const u = new THREE.Vector3(), w = new THREE.Vector3();
  if (Math.abs(normal.z) < 0.9) u.crossVectors(normal, new THREE.Vector3(0, 0, 1)).normalize();
  else u.crossVectors(normal, new THREE.Vector3(1, 0, 0)).normalize();
  w.crossVectors(normal, u);
  const o = pts[0];
  const p2 = pts.map((p) => new THREE.Vector2(p.clone().sub(o).dot(u), p.clone().sub(o).dot(w)));
  const tris = THREE.ShapeUtils.triangulateShape(p2, []);
  const pos = [];
  for (const t of tris) for (const i of t) pos.push(pts[i].x, pts[i].y, pts[i].z);
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: COLOR, transparent: true, opacity: 0.15, side: THREE.DoubleSide, depthTest: false }));
  m.renderOrder = 999;
  return m;
}

function label(text, pos, detail) {
  const div = document.createElement('div');
  div.className = 'measure-label';
  div.innerHTML = `<b>${escapeHtml(text)}</b>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}`;
  const o = new CSS2DObject(div);
  o.position.copy(pos);
  return o;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function disposeTree(o) {
  o.traverse((c) => {
    c.geometry?.dispose();
    c.material?.dispose?.();
    if (c.isCSS2DObject) c.element.remove();
  });
}
