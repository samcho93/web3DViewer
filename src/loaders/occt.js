// STEP / IGES / BREP -> three.js hierarchy (assembly tree preserved)
import * as THREE from 'three';
import { WorkerClient } from './workerClient.js';

const client = new WorkerClient(() => new Worker(new URL('../workers/occt.worker.js', import.meta.url), { type: 'module' }));

export async function loadOcct(format, buffer, onProgress, fileName) {
  onProgress('OpenCascade 엔진 로딩 및 형상 변환 중... (대용량 파일은 시간이 걸릴 수 있습니다)');
  const res = await client.call({ format, buffer }, [buffer]);
  onProgress('메쉬 생성 중...');

  const meshes = res.meshes.map((m, i) => buildMesh(m, i));
  const used = new Set();

  const buildNode = (node, depth) => {
    const group = new THREE.Group();
    group.name = node.name || (depth === 0 ? fileName : '어셈블리');
    for (const idx of node.meshes || []) {
      let mesh = meshes[idx];
      if (used.has(idx)) mesh = mesh.clone(); // instanced part
      used.add(idx);
      group.add(mesh);
    }
    for (const child of node.children || []) {
      const c = buildNode(child, depth + 1);
      if (c) group.add(c);
    }
    if (!group.children.length) return null;
    // collapse a group that only wraps a single mesh with the same/empty name
    if (depth > 0 && group.children.length === 1 && group.children[0].isMesh && (!node.name || node.name === group.children[0].name)) {
      const only = group.children[0];
      if (!only.name || only.name.startsWith('Solid')) only.name = node.name || only.name;
      return only;
    }
    return group;
  };

  let root = buildNode(res.root, 0);
  if (!root) throw new Error('형상 데이터가 없습니다.');
  if (root.isMesh) {
    const g = new THREE.Group();
    g.add(root);
    root = g;
  }
  root.name = fileName;
  return root;
}

function buildMesh(m, i) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
  if (m.normal && m.normal.length === m.position.length) g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
  if (m.index) g.setIndex(new THREE.BufferAttribute(m.index, 1));
  if (!g.attributes.normal) g.computeVertexNormals();

  const base = m.color ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : new THREE.Color(0xb8c2cc);
  const mat = new THREE.MeshStandardMaterial({ color: base, metalness: 0.2, roughness: 0.5, side: THREE.DoubleSide });

  // per-face colors -> vertex colors
  const faces = m.brepFaces || [];
  if (m.index && faces.some((f) => f.color && (!m.color || f.color.some((c, k) => Math.abs(c - m.color[k]) > 1e-3)))) {
    const n = m.position.length / 3;
    const colors = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) colors.set([base.r, base.g, base.b], v * 3);
    for (const f of faces) {
      if (!f.color) continue;
      for (let t = f.first; t <= f.last; t++)
        for (let k = 0; k < 3; k++) colors.set(f.color, m.index[t * 3 + k] * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    mat.vertexColors = true;
    mat.color.set(0xffffff);
  }

  const mesh = new THREE.Mesh(g, mat);
  mesh.name = m.name || `Solid ${i + 1}`;
  mesh.userData.brepFaces = faces.map((f) => ({ first: f.first, last: f.last, color: f.color }));
  return mesh;
}
