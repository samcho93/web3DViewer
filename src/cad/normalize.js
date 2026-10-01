// Normalizes DXF (dxf-parser) and DWG (libredwg-web) databases into one
// simple, tessellated drawing model that the 2D renderer consumes.
//
// Drawing = {
//   layers: { [name]: { color, visible, frozen } },
//   blocks: { [name]: { entities: Entity[] } },      // already shifted by base point
//   entities: Entity[],
//   stats: { [type]: count }
// }
// Entity = {
//   type, layer, color (int | null=BYLAYER | -1=BYBLOCK), handle,
//   kind: 'curve' | 'fill' | 'text' | 'insert' | 'point',
//   polys?:  number[][]   (flat xyz strips)          - curve / fill outlines
//   tris?:   number[]     (flat xyz triangle soup)   - fill
//   alpha?:  number                                  - fill opacity
//   text?, p?, h?, rot?, ha?, va?, wf?, lines?       - text
//   name?, m?  (column-major 4x4 transform)          - insert
//   info?: object (displayed in property panel)
// }
import { ShapeUtils, Vector2 } from 'three';
import ACI from './aci.js';

const TAU = Math.PI * 2;
const SEG_PER_CIRCLE = 72;

// ---------------------------------------------------------------- helpers
function isDefaultExtrusion(n) {
  return !n || (Math.abs(n.x || 0) < 1e-9 && Math.abs(n.y || 0) < 1e-9 && (n.z ?? 1) > 0);
}

// AutoCAD "arbitrary axis algorithm": returns OCS -> WCS mapper
function ocsMapper(n) {
  if (isDefaultExtrusion(n)) return null;
  let nx = n.x || 0, ny = n.y || 0, nz = n.z || 0;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  let ax, ay, az;
  if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) {
    // Wy x N
    ax = nz; ay = 0; az = -nx;
  } else {
    // Wz x N
    ax = -ny; ay = nx; az = 0;
  }
  const al = Math.hypot(ax, ay, az) || 1;
  ax /= al; ay /= al; az /= al;
  // N x Ax
  const bx = ny * az - nz * ay, by = nz * ax - nx * az, bz = nx * ay - ny * ax;
  return (x, y, z) => [x * ax + y * bx + z * nx, x * ay + y * by + z * ny, x * az + y * bz + z * nz];
}

function applyOcs(flat, map) {
  if (!map) return flat;
  for (let i = 0; i < flat.length; i += 3) {
    const r = map(flat[i], flat[i + 1], flat[i + 2]);
    flat[i] = r[0]; flat[i + 1] = r[1]; flat[i + 2] = r[2];
  }
  return flat;
}

function segCount(sweep) {
  return Math.max(4, Math.ceil((Math.abs(sweep) / TAU) * SEG_PER_CIRCLE));
}

function arcFlat(cx, cy, z, r, a0, a1, out = []) {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += TAU;
  if (sweep > TAU + 1e-9) sweep = TAU;
  const n = segCount(sweep);
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a), z);
  }
  return out;
}

function circleFlat(cx, cy, z, r) {
  const out = [];
  for (let i = 0; i <= SEG_PER_CIRCLE; i++) {
    const a = (TAU * i) / SEG_PER_CIRCLE;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a), z);
  }
  return out;
}

// Appends the bulge arc p1->p2 (excluding p1) to out
function bulgeTo(out, x1, y1, x2, y2, z, b) {
  if (!b || Math.abs(b) < 1e-9) { out.push(x2, y2, z); return; }
  const theta = 4 * Math.atan(b);
  const dx = x2 - x1, dy = y2 - y1;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12) return;
  const r = chord / (2 * Math.sin(theta / 2));
  const h = r * Math.cos(theta / 2);
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const cx = mx - (dy / chord) * h, cy = my + (dx / chord) * h;
  const a1 = Math.atan2(y1 - cy, x1 - cx);
  const rr = Math.abs(r);
  const n = segCount(theta);
  for (let i = 1; i <= n; i++) {
    const a = a1 + (theta * i) / n;
    out.push(cx + rr * Math.cos(a), cy + rr * Math.sin(a), z);
  }
}

// verts: [{x,y,z?,bulge?}] -> flat strip (OCS)
function polyFlat(verts, closed, elev = 0) {
  const out = [];
  if (!verts.length) return out;
  const z0 = (v) => (v.z ?? elev) || elev;
  out.push(verts[0].x, verts[0].y, z0(verts[0]));
  const n = verts.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = verts[i], b = verts[(i + 1) % n];
    bulgeTo(out, a.x, a.y, b.x, b.y, z0(b), a.bulge || 0);
  }
  return out;
}

function ellipseFlat(c, maj, ratio, t0, t1, normal) {
  const n = normal && !isDefaultExtrusion(normal) ? normal : { x: 0, y: 0, z: 1 };
  // minor = (N x M) * ratio
  const mx = (n.y * (maj.z || 0) - n.z * maj.y) * ratio;
  const my = (n.z * maj.x - n.x * (maj.z || 0)) * ratio;
  const mz = (n.x * maj.y - n.y * maj.x) * ratio;
  let sweep = t1 - t0;
  while (sweep <= 0) sweep += TAU;
  if (sweep > TAU + 1e-9) sweep = TAU;
  const cnt = segCount(sweep);
  const out = [];
  for (let i = 0; i <= cnt; i++) {
    const t = t0 + (sweep * i) / cnt;
    const ct = Math.cos(t), st = Math.sin(t);
    out.push(c.x + maj.x * ct + mx * st, c.y + maj.y * ct + my * st, (c.z || 0) + (maj.z || 0) * ct + mz * st);
  }
  return out;
}

// NURBS evaluation (de Boor), returns flat xyz
function splineFlat(degree, cps, knots, weights) {
  const n = cps.length;
  if (n < 2) return [];
  const p = Math.min(degree || 3, n - 1);
  if (!knots || knots.length !== n + p + 1) {
    // clamped uniform fallback
    knots = [];
    for (let i = 0; i <= n + p; i++) knots.push(i <= p ? 0 : i >= n ? n - p : i - p);
  }
  const w = weights && weights.length === n ? weights : null;
  const tMin = knots[p], tMax = knots[n];
  const samples = Math.min(2000, Math.max(32, n * 12));
  const out = [];
  for (let s = 0; s <= samples; s++) {
    let t = tMin + ((tMax - tMin) * s) / samples;
    if (s === samples) t = tMax - 1e-10 * (tMax - tMin || 1);
    let k = p;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= p; j++) {
      const cp = cps[k - p + j];
      const wt = w ? w[k - p + j] : 1;
      d.push([cp.x * wt, cp.y * wt, (cp.z || 0) * wt, wt]);
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j;
        const den = knots[i + p - r + 1] - knots[i];
        const a = den === 0 ? 0 : (t - knots[i]) / den;
        for (let q = 0; q < 4; q++) d[j][q] = (1 - a) * d[j - 1][q] + a * d[j][q];
      }
    }
    const r = d[p];
    out.push(r[0] / r[3], r[1] / r[3], r[2] / r[3]);
  }
  return out;
}

function catmullFlat(pts) {
  if (pts.length < 3) return pts.flatMap((p) => [p.x, p.y, p.z || 0]);
  const out = [];
  const P = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const steps = 12;
    for (let s = i === 0 ? 0 : 1; s <= steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y), f(p0.z || 0, p1.z || 0, p2.z || 0, p3.z || 0));
    }
  }
  return out;
}

function flatLength(flat) {
  let L = 0;
  for (let i = 3; i < flat.length; i += 3) L += Math.hypot(flat[i] - flat[i - 3], flat[i + 1] - flat[i - 2], flat[i + 2] - flat[i - 1]);
  return L;
}

function polyArea2D(flat) {
  let a = 0;
  const n = flat.length / 3;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += flat[i * 3] * flat[j * 3 + 1] - flat[j * 3] * flat[i * 3 + 1];
  }
  return a / 2;
}

// Triangulates closed loops (outer = largest, others = holes)
function triangulateLoops(loops, z = 0) {
  const valid = loops.filter((l) => l.length >= 9);
  if (!valid.length) return [];
  const withArea = valid.map((l) => ({ l, a: Math.abs(polyArea2D(l)) })).sort((a, b) => b.a - a.a);
  const toV2 = (flat) => {
    const pts = [];
    for (let i = 0; i < flat.length; i += 3) {
      const v = new Vector2(flat[i], flat[i + 1]);
      if (!pts.length || pts[pts.length - 1].distanceToSquared(v) > 1e-18) pts.push(v);
    }
    if (pts.length > 2 && pts[0].distanceToSquared(pts[pts.length - 1]) < 1e-18) pts.pop();
    return pts;
  };
  const outer = toV2(withArea[0].l);
  const holes = withArea.slice(1).map((o) => toV2(o.l)).filter((h) => h.length >= 3);
  if (outer.length < 3) return [];
  let faces;
  try {
    faces = ShapeUtils.triangulateShape(outer, holes);
  } catch {
    return [];
  }
  const all = outer.concat(...holes);
  const tris = [];
  for (const f of faces) for (const i of f) tris.push(all[i].x, all[i].y, z);
  return tris;
}

// Removes MTEXT inline formatting codes
export function cleanMText(s) {
  if (!s) return '';
  return s
    .replace(/\\P/g, '\n')
    .replace(/\\[Xx]/g, '\n')
    .replace(/\\S([^;]*?)[#^/]([^;]*?);/g, '$1/$2')
    .replace(/\\[ACcFfHhQqTtWwp][^;]*;/g, '')
    .replace(/\\[LlOoKkNn]/g, '')
    .replace(/\\~/g, ' ')
    .replace(/\\\\/g, '\\')
    .replace(/[{}]/g, '')
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[uUoO]/g, '');
}

function cleanText(s) {
  return (s || '').replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[uUoO]/g, '');
}

// column-major 4x4 for INSERT: T(p) * OCS * Rz(rot) * S(sx,sy,sz)
function insertMatrix(p, sx, sy, sz, rot, extrusion) {
  const c = Math.cos(rot), s = Math.sin(rot);
  // local basis after rotation & scale (in OCS)
  let X = [c * sx, s * sx, 0], Y = [-s * sy, c * sy, 0], Z = [0, 0, sz], T = [p.x, p.y, p.z || 0];
  const map = ocsMapper(extrusion);
  if (map) {
    X = map(...X); Y = map(...Y); Z = map(...Z); T = map(...T);
  }
  return [X[0], X[1], X[2], 0, Y[0], Y[1], Y[2], 0, Z[0], Z[1], Z[2], 0, T[0], T[1], T[2], 1];
}

function mulMat(a, b) {
  const r = new Array(16);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
      r[i * 4 + j] = s;
    }
  return r;
}

function translateMat(x, y, z) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

const HALIGN = { 0: 0, 1: 1, 2: 2, 3: 0, 4: 1, 5: 0 };

// =========================================================== DXF (dxf-parser)
function dxfColor(e) {
  if (e.colorIndex === 0) return -1;
  if (e.colorIndex === 256 || e.colorIndex == null) {
    // true color (420) may exist without index
    return e.color != null && e.colorIndex == null ? e.color : null;
  }
  return e.color ?? ACI[Math.abs(e.colorIndex)] ?? null;
}

function dxfEntity(e) {
  const base = { type: e.type, layer: e.layer ?? '0', color: dxfColor(e), handle: e.handle };
  const extr = e.extrusionDirection || (e.extrusionDirectionZ != null ? { x: e.extrusionDirectionX || 0, y: e.extrusionDirectionY || 0, z: e.extrusionDirectionZ } : null);
  const map = ocsMapper(extr);
  switch (e.type) {
    case 'LINE': {
      const [a, b] = e.vertices;
      if (!a || !b) return null;
      const f = [a.x, a.y, a.z || 0, b.x, b.y, b.z || 0];
      return { ...base, kind: 'curve', polys: [f], info: { 길이: flatLength(f) } };
    }
    case 'LWPOLYLINE': {
      if (!e.vertices?.length) return null;
      const f = applyOcs(polyFlat(e.vertices, !!e.shape, e.elevation || 0), map);
      return { ...base, kind: 'curve', polys: [f], info: { 정점수: e.vertices.length, 닫힘: !!e.shape, 길이: flatLength(f) } };
    }
    case 'POLYLINE': {
      const vs = e.vertices || [];
      if (e.isPolyfaceMesh) {
        const pts = vs.filter((v) => v.threeDPolylineMesh);
        const faces = vs.filter((v) => !v.threeDPolylineMesh && v.faceA != null);
        return polyfaceEntity(base, pts, faces.map((f) => [f.faceA, f.faceB, f.faceC, f.faceD]));
      }
      if (!vs.length) return null;
      const f = e.is3dPolyline ? polyFlat(vs.map((v) => ({ x: v.x, y: v.y, z: v.z })), !!e.shape) : applyOcs(polyFlat(vs, !!e.shape), ocsMapper(e.extrusionDirection));
      return { ...base, kind: 'curve', polys: [f], info: { 정점수: vs.length, 닫힘: !!e.shape, 길이: flatLength(f) } };
    }
    case 'CIRCLE': {
      const f = applyOcs(circleFlat(e.center.x, e.center.y, e.center.z || 0, e.radius), map);
      return { ...base, kind: 'curve', polys: [f], info: { 중심: pt(e.center), 반지름: e.radius, 지름: e.radius * 2 } };
    }
    case 'ARC': {
      const f = applyOcs(arcFlat(e.center.x, e.center.y, e.center.z || 0, e.radius, e.startAngle, e.endAngle), map);
      return { ...base, kind: 'curve', polys: [f], info: { 중심: pt(e.center), 반지름: e.radius, 시작각: deg(e.startAngle), 끝각: deg(e.endAngle), 길이: flatLength(f) } };
    }
    case 'ELLIPSE': {
      const f = ellipseFlat(e.center, e.majorAxisEndPoint, e.axisRatio, e.startAngle ?? 0, e.endAngle ?? TAU, extr);
      return { ...base, kind: 'curve', polys: [f], info: { 중심: pt(e.center), 장축비: e.axisRatio } };
    }
    case 'SPLINE': {
      let f = [];
      if (e.controlPoints?.length > 1) f = splineFlat(e.degreeOfSplineCurve, e.controlPoints, e.knotValues, e.weights);
      else if (e.fitPoints?.length > 1) f = catmullFlat(e.fitPoints);
      if (!f.length) return null;
      return { ...base, kind: 'curve', polys: [f], info: { 차수: e.degreeOfSplineCurve, 제어점: e.controlPoints?.length || 0, 길이: flatLength(f) } };
    }
    case 'TEXT': {
      if (!e.text) return null;
      const useEnd = (e.halign || e.valign) && e.endPoint;
      const p = useEnd ? e.endPoint : e.startPoint;
      const pw = map ? map(p.x, p.y, p.z || 0) : [p.x, p.y, p.z || 0];
      return { ...base, kind: 'text', text: cleanText(e.text), p: pw, h: e.textHeight || 1, rot: deg2rad(e.rotation || 0), ha: HALIGN[e.halign || 0] ?? 0, va: e.valign || 0, wf: e.xScale || 1, info: { 문자: e.text, 높이: e.textHeight } };
    }
    case 'MTEXT': {
      if (!e.text) return null;
      let rot = deg2rad(e.rotation || 0);
      if (e.directionVector) rot = Math.atan2(e.directionVector.y, e.directionVector.x);
      const ap = e.attachmentPoint || 1;
      const txt = cleanMText(e.text);
      return { ...base, kind: 'text', text: txt, p: [e.position.x, e.position.y, e.position.z || 0], h: e.height || 1, rot, ha: (ap - 1) % 3, va: 3 - Math.floor((ap - 1) / 3), mtext: true, info: { 문자: txt, 높이: e.height } };
    }
    case 'INSERT': {
      const m = insertMatrix(e.position || { x: 0, y: 0, z: 0 }, e.xScale ?? 1, e.yScale ?? 1, e.zScale ?? 1, deg2rad(e.rotation || 0), e.extrusionDirection);
      return insertArray(base, e.name, m, e.columnCount, e.rowCount, e.columnSpacing, e.rowSpacing, e.rotation ? deg2rad(e.rotation) : 0, { 블록: e.name, 위치: pt(e.position), 회전: e.rotation || 0, 축척: `${e.xScale ?? 1}, ${e.yScale ?? 1}` });
    }
    case 'DIMENSION': {
      if (!e.block) return null;
      return { ...base, kind: 'insert', name: e.block, m: translateMat(0, 0, 0), info: { 블록: e.block, 측정값: e.actualMeasurement, 문자: e.text } };
    }
    case 'SOLID': {
      const ps = (e.points || []).filter(Boolean);
      return solidEntity(base, ps, map);
    }
    case '3DFACE': {
      const ps = (e.vertices || []).filter((v) => v && v.x != null);
      return faceEntity(base, ps);
    }
    case 'POINT': {
      const p = e.position;
      return { ...base, kind: 'point', p: [p.x, p.y, p.z || 0], info: { 위치: pt(p) } };
    }
    default:
      return null;
  }
}

export function normalizeDxf(dxf) {
  const stats = {};
  const layers = {};
  const L = dxf.tables?.layer?.layers || {};
  for (const [name, l] of Object.entries(L)) {
    if (!name || name === 'undefined') continue;
    layers[name] = { color: l.color ?? ACI[l.colorIndex] ?? 0xffffff, visible: l.visible !== false, frozen: !!l.frozen };
  }
  const conv = (list) => {
    const out = [];
    for (const e of list || []) {
      if (e.inPaperSpace) continue;
      if (e.visible === false) continue;
      let ne = null;
      try { ne = dxfEntity(e); } catch { ne = null; }
      stats[e.type] = (stats[e.type] || 0) + 1;
      if (ne) out.push(ne);
    }
    return out;
  };
  const blocks = {};
  for (const [name, b] of Object.entries(dxf.blocks || {})) {
    const ents = conv((b.entities || []).filter((e) => e.type !== 'ATTDEF'));
    blocks[name] = { entities: ents, base: b.position || { x: 0, y: 0, z: 0 } };
  }
  const entities = conv(dxf.entities);
  return finalize({ layers, blocks, entities, stats, format: 'DXF', version: dxf.header?.$ACADVER, insUnits: dxf.header?.$INSUNITS });
}

// ============================================================ DWG (libredwg)
function dwgColor(e) {
  if (e.color != null) return e.color;
  const ci = e.colorIndex;
  if (ci == null || ci === 256) return null;
  if (ci === 0) return -1;
  return ACI[Math.abs(ci)] ?? null;
}

function dwgEntity(e) {
  const base = { type: e.type, layer: e.layer ?? '0', color: dwgColor(e), handle: e.handle };
  const map = ocsMapper(e.extrusionDirection);
  switch (e.type) {
    case 'LINE': {
      const a = e.startPoint, b = e.endPoint;
      const f = [a.x, a.y, a.z || 0, b.x, b.y, b.z || 0];
      return { ...base, kind: 'curve', polys: [f], info: { 길이: flatLength(f) } };
    }
    case 'LWPOLYLINE': {
      if (!e.vertices?.length) return null;
      const closed = !!(e.flag & 512);
      const f = applyOcs(polyFlat(e.vertices, closed, e.elevation || 0), map);
      return { ...base, kind: 'curve', polys: [f], info: { 정점수: e.vertices.length, 닫힘: closed, 길이: flatLength(f) } };
    }
    case 'POLYLINE2D': {
      const vs = (e.vertices || []).filter((v) => !(v.flag & 16));
      if (!vs.length) return null;
      const closed = !!(e.flag & 1);
      const f = applyOcs(polyFlat(vs, closed, e.elevation || 0), map);
      return { ...base, kind: 'curve', polys: [f], info: { 정점수: vs.length, 닫힘: closed, 길이: flatLength(f) } };
    }
    case 'POLYLINE3D': {
      const vs = (e.vertices || []).filter((v) => !(v.flag & 16));
      if (!vs.length) return null;
      const closed = !!(e.flag & 1);
      const f = polyFlat(vs.map((v) => ({ x: v.x, y: v.y, z: v.z })), closed);
      return { ...base, kind: 'curve', polys: [f], info: { 정점수: vs.length, 닫힘: closed, 길이: flatLength(f) } };
    }
    case 'CIRCLE': {
      const c = e.center;
      const f = applyOcs(circleFlat(c.x, c.y, c.z || 0, e.radius), map);
      return { ...base, kind: 'curve', polys: [f], info: { 중심: pt(c), 반지름: e.radius, 지름: e.radius * 2 } };
    }
    case 'ARC': {
      const c = e.center;
      const f = applyOcs(arcFlat(c.x, c.y, c.z || 0, e.radius, e.startAngle, e.endAngle), map);
      return { ...base, kind: 'curve', polys: [f], info: { 중심: pt(c), 반지름: e.radius, 시작각: deg(e.startAngle), 끝각: deg(e.endAngle), 길이: flatLength(f) } };
    }
    case 'ELLIPSE': {
      const f = ellipseFlat(e.center, e.majorAxisEndPoint, e.axisRatio, e.startAngle ?? 0, e.endAngle ?? TAU, e.extrusionDirection);
      return { ...base, kind: 'curve', polys: [f], info: { 중심: pt(e.center), 장축비: e.axisRatio } };
    }
    case 'SPLINE': {
      let f = [];
      if (e.controlPoints?.length > 1) f = splineFlat(e.degree, e.controlPoints, e.knots, e.weights);
      else if (e.fitPoints?.length > 1) f = catmullFlat(e.fitPoints);
      if (!f.length) return null;
      return { ...base, kind: 'curve', polys: [f], info: { 차수: e.degree, 제어점: e.controlPoints?.length || 0, 길이: flatLength(f) } };
    }
    case 'TEXT':
    case 'ATTRIB': {
      if (!e.text || e.isInvisible) return null;
      const useEnd = (e.halign || e.valign) && e.endPoint;
      const p = useEnd ? e.endPoint : e.startPoint;
      const z = p.z || 0;
      const pw = map ? map(p.x, p.y, z) : [p.x, p.y, z];
      return { ...base, kind: 'text', text: cleanText(e.text), p: pw, h: e.textHeight || 1, rot: e.rotation || 0, ha: HALIGN[e.halign || 0] ?? 0, va: e.valign || 0, wf: e.xScale || 1, info: { 문자: e.text, 높이: e.textHeight } };
    }
    case 'MTEXT': {
      if (!e.text) return null;
      let rot = e.rotation || 0;
      if (e.direction && (e.direction.x || e.direction.y)) rot = Math.atan2(e.direction.y, e.direction.x);
      const ap = e.attachmentPoint || 1;
      const p = e.insertionPoint;
      const txt = cleanMText(e.text);
      return { ...base, kind: 'text', text: txt, p: [p.x, p.y, p.z || 0], h: e.textHeight || 1, rot, ha: (ap - 1) % 3, va: 3 - Math.floor((ap - 1) / 3), mtext: true, info: { 문자: txt, 높이: e.textHeight } };
    }
    case 'INSERT': {
      const m = insertMatrix(e.insertionPoint, e.xScale ?? 1, e.yScale ?? 1, e.zScale ?? 1, e.rotation || 0, e.extrusionDirection);
      const ins = insertArray(base, e.name, m, e.columnCount, e.rowCount, e.columnSpacing, e.rowSpacing, e.rotation || 0, { 블록: e.name, 위치: pt(e.insertionPoint), 회전: deg(e.rotation || 0), 축척: `${e.xScale ?? 1}, ${e.yScale ?? 1}` });
      const attribs = (e.attribs || []).map(dwgEntity).filter(Boolean);
      if (attribs.length) return [ins, ...attribs];
      return ins;
    }
    case 'DIMENSION': {
      if (!e.name) return null;
      return { ...base, kind: 'insert', name: e.name, m: translateMat(0, 0, 0), info: { 블록: e.name, 측정값: e.measurement, 문자: e.text } };
    }
    case 'SOLID': {
      const ps = [e.corner1, e.corner2, e.corner3, e.corner4].filter(Boolean).map((c) => ({ x: c.x, y: c.y, z: e.elevation || 0 }));
      return solidEntity(base, ps, map);
    }
    case '3DFACE': {
      const ps = [e.corner1, e.corner2, e.corner3, e.corner4].filter(Boolean);
      return faceEntity(base, ps);
    }
    case 'HATCH':
      return hatchEntity(base, e, map);
    case 'POINT': {
      const p = e.position;
      return { ...base, kind: 'point', p: [p.x, p.y, p.z || 0], info: { 위치: pt(p) } };
    }
    case 'LEADER': {
      if (!e.vertices?.length) return null;
      const f = e.vertices.flatMap((v) => [v.x, v.y, v.z || 0]);
      return { ...base, kind: 'curve', polys: [f] };
    }
    case 'WIPEOUT':
      return null;
    default:
      return null;
  }
}

export function normalizeDwg(db) {
  const stats = {};
  const layers = {};
  for (const l of db.tables?.LAYER?.entries || []) {
    const ci = l.colorIndex;
    const color = ci >= 1 && ci <= 255 ? ACI[ci] : l.color ?? 0xffffff;
    layers[l.name] = { color, visible: !l.off && (ci == null || ci >= 0), frozen: !!l.frozen };
  }
  const conv = (list) => {
    const out = [];
    for (const e of list || []) {
      if (e.isInPaperSpace) continue;
      if (e.isVisible === false) continue;
      stats[e.type] = (stats[e.type] || 0) + 1;
      let ne = null;
      try { ne = dwgEntity(e); } catch { ne = null; }
      if (Array.isArray(ne)) out.push(...ne);
      else if (ne) out.push(ne);
    }
    return out;
  };
  const blocks = {};
  for (const b of db.tables?.BLOCK_RECORD?.entries || []) {
    const n = (b.name || '').toUpperCase();
    if (n === '*MODEL_SPACE' || n.startsWith('*PAPER_SPACE')) continue;
    blocks[b.name] = { entities: conv((b.entities || []).filter((e) => e.type !== 'ATTDEF')), base: b.basePoint || { x: 0, y: 0, z: 0 } };
  }
  const entities = conv(db.entities);
  return finalize({ layers, blocks, entities, stats, format: 'DWG', version: db.header?.ACADVER || db.header?.$ACADVER, insUnits: db.header?.INSUNITS ?? db.header?.$INSUNITS });
}

// ============================================================ shared builders
function insertArray(base, name, m, cols = 1, rows = 1, cs = 0, rs = 0, rot = 0, info) {
  cols = Math.max(1, cols || 1); rows = Math.max(1, rows || 1);
  if (cols === 1 && rows === 1) return { ...base, kind: 'insert', name, m, info };
  // MINSERT: offsets are along the rotated insert axes
  const c = Math.cos(rot), s = Math.sin(rot);
  const list = [];
  for (let r = 0; r < rows; r++)
    for (let k = 0; k < cols; k++) {
      const dx = k * cs, dy = r * rs;
      const t = translateMat(dx * c - dy * s, dx * s + dy * c, 0);
      list.push({ ...base, kind: 'insert', name, m: mulMat(t, m), info });
    }
  return list;
}

function solidEntity(base, ps, map) {
  if (ps.length < 3) return null;
  const v = ps.map((p) => (map ? map(p.x, p.y, p.z || 0) : [p.x, p.y, p.z || 0]));
  const tris = [...v[0], ...v[1], ...v[2]];
  if (v[3] && (v[3][0] !== v[2][0] || v[3][1] !== v[2][1])) tris.push(...v[1], ...v[3], ...v[2]);
  return { ...base, kind: 'fill', tris, alpha: 1 };
}

function faceEntity(base, ps) {
  if (ps.length < 3) return null;
  const v = ps.map((p) => [p.x, p.y, p.z || 0]);
  const tris = [...v[0], ...v[1], ...v[2]];
  const outline = [...v[0], ...v[1], ...v[2]];
  if (v[3] && (v[3][0] !== v[2][0] || v[3][1] !== v[2][1] || v[3][2] !== v[2][2])) {
    tris.push(...v[0], ...v[2], ...v[3]);
    outline.push(...v[3]);
  }
  outline.push(...v[0]);
  return { ...base, kind: 'curve', polys: [outline], tris, alpha: 1 };
}

function polyfaceEntity(base, pts, faces) {
  const tris = [];
  const polys = [];
  const P = (i) => pts[Math.abs(i) - 1];
  for (const f of faces) {
    const idx = f.filter((i) => i);
    if (idx.length < 3) continue;
    const vs = idx.map(P);
    if (vs.some((v) => !v)) continue;
    for (let i = 1; i < vs.length - 1; i++) tris.push(vs[0].x, vs[0].y, vs[0].z || 0, vs[i].x, vs[i].y, vs[i].z || 0, vs[i + 1].x, vs[i + 1].y, vs[i + 1].z || 0);
    for (let i = 0; i < idx.length; i++) {
      if (idx[i] < 0) continue; // invisible edge
      const a = vs[i], b = vs[(i + 1) % vs.length];
      polys.push([a.x, a.y, a.z || 0, b.x, b.y, b.z || 0]);
    }
  }
  if (!tris.length) return null;
  return { ...base, kind: 'curve', polys, tris, alpha: 1, info: { 면수: faces.length } };
}

function hatchEntity(base, e, map) {
  const loops = [];
  for (const path of e.boundaryPaths || []) {
    let flat = [];
    if (path.vertices) {
      flat = polyFlat(path.vertices.map((v) => ({ x: v.x, y: v.y, bulge: path.hasBulge ? v.bulge : 0 })), true, 0);
    } else if (path.edges) {
      for (const ed of path.edges) {
        let seg = [];
        if (ed.type === 1) seg = [ed.start.x, ed.start.y, 0, ed.end.x, ed.end.y, 0];
        else if (ed.type === 2) {
          let a0 = ed.startAngle, a1 = ed.endAngle;
          if (ed.isCCW === false) { // clockwise arc: angles are mirrored
            seg = arcFlat(ed.center.x, ed.center.y, 0, ed.radius, -a1, -a0);
            // reverse to keep path direction
            const rev = [];
            for (let i = seg.length - 3; i >= 0; i -= 3) rev.push(seg[i], seg[i + 1], seg[i + 2]);
            seg = rev;
          } else seg = arcFlat(ed.center.x, ed.center.y, 0, ed.radius, a0, a1);
        } else if (ed.type === 3) {
          const maj = { x: ed.end.x, y: ed.end.y, z: 0 };
          seg = ellipseFlat({ x: ed.center.x, y: ed.center.y, z: 0 }, maj, ed.lengthOfMinorAxis, ed.isCCW === false ? -ed.endAngle : ed.startAngle, ed.isCCW === false ? -ed.startAngle : ed.endAngle);
        } else if (ed.type === 4) {
          const cps = (ed.controlPoints || []).map((p) => ({ x: p.x, y: p.y, z: 0 }));
          const w = (ed.controlPoints || []).map((p) => p.weight ?? 1);
          seg = splineFlat(ed.degree, cps, ed.knots, ed.isRational ? w : null);
        }
        flat.push(...seg);
      }
    }
    if (flat.length >= 6) loops.push(flat);
  }
  if (!loops.length) return null;
  const solid = e.solidFill === 1;
  const tris = triangulateLoops(loops, 0);
  applyOcs(tris, map);
  const polys = loops.map((l) => {
    const c = l.slice();
    if (c[0] !== c[c.length - 3] || c[1] !== c[c.length - 2]) c.push(c[0], c[1], c[2]);
    return applyOcs(c, map);
  });
  return { ...base, kind: solid ? 'fill' : 'curve', polys: solid ? undefined : polys, tris, alpha: solid ? 1 : 0.18, info: { 패턴: e.patternName, 채움: solid ? '솔리드' : '패턴' } };
}

function finalize(d) {
  // shift block entities by base point via a wrapping transform
  for (const b of Object.values(d.blocks)) {
    const bp = b.base || { x: 0, y: 0, z: 0 };
    b.offset = [-(bp.x || 0), -(bp.y || 0), -(bp.z || 0)];
    delete b.base;
  }
  if (!d.layers['0']) d.layers['0'] = { color: 0xffffff, visible: true, frozen: false };
  return d;
}

const pt = (p) => (p ? `${fmt(p.x)}, ${fmt(p.y)}${p.z ? ', ' + fmt(p.z) : ''}` : '');
const fmt = (n) => (Math.round((n || 0) * 1000) / 1000).toString();
const deg = (r) => Math.round(((r * 180) / Math.PI) * 1000) / 1000;
const deg2rad = (d) => (d * Math.PI) / 180;
