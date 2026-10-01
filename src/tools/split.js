// Element decomposition helpers:
//  - splitByConnectivity: splits a mesh into its connected (welded) components
//  - splitByBrepFaces:    splits a STEP/IGES body into its B-rep faces
//  - meshStats:           triangle count, surface area, volume, bbox
import * as THREE from 'three';

function srcMaterial(mesh) {
  return Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
}

function freshMaterial(mesh) {
  const src = srcMaterial(mesh);
  const m = src.clone();
  // Material.clone() JSON-copies userData, so read the live originals from the source
  const orig = src.userData.orig;
  if (orig) {
    if (orig.color && m.color) m.color.copy(orig.color);
    if (orig.emissive && m.emissive) m.emissive.copy(orig.emissive);
    m.opacity = orig.opacity;
    m.transparent = orig.transparent;
    m.depthWrite = orig.depthWrite;
  }
  m.wireframe = false;
  m.colorWrite = true;
  m.userData = {};
  return m;
}

/** builds a new geometry from a subset of triangles (by triangle index list) */
function subGeometry(geo, triList) {
  const src = geo.index;
  const map = new Map();
  const newIndex = [];
  const attrs = Object.keys(geo.attributes);
  const out = Object.fromEntries(attrs.map((k) => [k, []]));
  for (const t of triList) {
    for (let k = 0; k < 3; k++) {
      const vi = src ? src.getX(t * 3 + k) : t * 3 + k;
      let ni = map.get(vi);
      if (ni === undefined) {
        ni = map.size;
        map.set(vi, ni);
        for (const a of attrs) {
          const at = geo.attributes[a];
          for (let c = 0; c < at.itemSize; c++) out[a].push(at.array[vi * at.itemSize + c]);
        }
      }
      newIndex.push(ni);
    }
  }
  const g = new THREE.BufferGeometry();
  for (const a of attrs) {
    const at = geo.attributes[a];
    const Ctor = at.array.constructor;
    g.setAttribute(a, new THREE.BufferAttribute(new Ctor(out[a]), at.itemSize, at.normalized));
  }
  g.setIndex(map.size > 65535 ? new THREE.Uint32BufferAttribute(newIndex, 1) : new THREE.Uint16BufferAttribute(newIndex, 1));
  return g;
}

export function splitByConnectivity(mesh, maxParts = 5000) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const triCount = geo.index ? geo.index.count / 3 : pos.count / 3;
  if (triCount > 6_000_000) throw new Error('삼각형이 너무 많아 분할할 수 없습니다.');

  // weld vertices by quantized position
  geo.computeBoundingBox();
  const size = geo.boundingBox.getSize(new THREE.Vector3()).length() || 1;
  const q = 1e-6 * size;
  const weld = new Int32Array(pos.count);
  const keyMap = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) / q)},${Math.round(pos.getY(i) / q)},${Math.round(pos.getZ(i) / q)}`;
    let id = keyMap.get(key);
    if (id === undefined) keyMap.set(key, (id = keyMap.size));
    weld[i] = id;
  }
  // union-find over welded vertices
  const parent = new Int32Array(keyMap.size);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const vid = (t, k) => weld[geo.index ? geo.index.getX(t * 3 + k) : t * 3 + k];
  for (let t = 0; t < triCount; t++) {
    const a = find(vid(t, 0)), b = find(vid(t, 1)), c = find(vid(t, 2));
    if (a !== b) parent[a] = b;
    const b2 = find(b);
    if (find(c) !== b2) parent[find(c)] = b2;
  }
  const groups = new Map();
  for (let t = 0; t < triCount; t++) {
    const r = find(vid(t, 0));
    let arr = groups.get(r);
    if (!arr) groups.set(r, (arr = []));
    arr.push(t);
  }
  if (groups.size <= 1) return null;
  if (groups.size > maxParts) throw new Error(`분리된 요소가 너무 많습니다 (${groups.size}개).`);

  const group = new THREE.Group();
  group.name = mesh.name;
  const sorted = [...groups.values()].sort((a, b) => b.length - a.length);
  sorted.forEach((tris, i) => {
    const g = subGeometry(geo, tris);
    const m = new THREE.Mesh(g, freshMaterial(mesh));
    m.name = `${mesh.name} - 요소 ${i + 1}`;
    group.add(m);
  });
  return group;
}

export function splitByBrepFaces(mesh) {
  const faces = mesh.userData.brepFaces;
  if (!faces || faces.length <= 1) return null;
  const group = new THREE.Group();
  group.name = mesh.name;
  faces.forEach((f, i) => {
    const tris = [];
    for (let t = f.first; t <= f.last; t++) tris.push(t);
    if (!tris.length) return;
    const g = subGeometry(mesh.geometry, tris);
    const mat = freshMaterial(mesh);
    if (f.color && !g.attributes.color) mat.color.setRGB(f.color[0], f.color[1], f.color[2]);
    const m = new THREE.Mesh(g, mat);
    m.name = `${mesh.name} - 면 ${i + 1}`;
    group.add(m);
  });
  return group;
}

/** statistics in world space for an object subtree */
export function meshStats(root) {
  let tris = 0, verts = 0, area = 0, volume = 0, meshes = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    if (!o.isMesh || o.name === '__edges' || o.userData.helper) return;
    meshes++;
    const g = o.geometry;
    const pos = g.attributes.position;
    const idx = g.index;
    const n = idx ? idx.count / 3 : pos.count / 3;
    tris += n;
    verts += pos.count;
    const M = o.matrixWorld;
    if (n > 3_000_000) return;
    for (let t = 0; t < n; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(M);
      b.fromBufferAttribute(pos, i1).applyMatrix4(M);
      c.fromBufferAttribute(pos, i2).applyMatrix4(M);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      area += ab.cross(ac).length() / 2;
      volume += a.dot(b.clone().cross(c)) / 6;
    }
  });
  const box = new THREE.Box3().setFromObject(root);
  return { tris, verts, area, volume: Math.abs(volume), meshes, box };
}
