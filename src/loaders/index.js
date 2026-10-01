// File-format dispatch: picks the right loader for each supported extension
import * as THREE from 'three';
import { loadOcct } from './occt.js';
import { loadCad2D } from './cad2d.js';

export const FORMATS = {
  // B-rep CAD (OpenCascade)
  step: { ext: ['step', 'stp'], kind: '3d', label: 'STEP' },
  iges: { ext: ['iges', 'igs'], kind: '3d', label: 'IGES' },
  brep: { ext: ['brep', 'brp'], kind: '3d', label: 'BREP' },
  // Mesh formats (three.js)
  stl: { ext: ['stl'], kind: '3d', label: 'STL' },
  obj: { ext: ['obj'], kind: '3d', label: 'OBJ', yUp: true },
  gltf: { ext: ['gltf', 'glb'], kind: '3d', label: 'glTF', yUp: true },
  fbx: { ext: ['fbx'], kind: '3d', label: 'FBX', yUp: true },
  ply: { ext: ['ply'], kind: '3d', label: 'PLY' },
  '3mf': { ext: ['3mf'], kind: '3d', label: '3MF' },
  dae: { ext: ['dae'], kind: '3d', label: 'Collada', yUp: true },
  '3ds': { ext: ['3ds'], kind: '3d', label: '3DS' },
  amf: { ext: ['amf'], kind: '3d', label: 'AMF' },
  vrml: { ext: ['wrl', 'vrml'], kind: '3d', label: 'VRML', yUp: true },
  vtk: { ext: ['vtk', 'vtp'], kind: '3d', label: 'VTK' },
  xyz: { ext: ['xyz'], kind: '3d', label: 'XYZ 점군' },
  pcd: { ext: ['pcd'], kind: '3d', label: 'PCD 점군' },
  // 2D drawings
  dxf: { ext: ['dxf'], kind: '2d', label: 'DXF' },
  dwg: { ext: ['dwg'], kind: '2d', label: 'DWG' },
};

// auxiliary files that may accompany a main model file
const AUX_EXT = new Set(['mtl', 'bin', 'png', 'jpg', 'jpeg', 'bmp', 'tga', 'gif', 'webp', 'ktx2', 'dds']);

export function extOf(name) {
  const m = /\.([^.\\/]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function formatOf(name) {
  const ext = extOf(name);
  for (const [key, f] of Object.entries(FORMATS)) if (f.ext.includes(ext)) return { key, ...f };
  return null;
}

export const ACCEPT = Object.values(FORMATS).flatMap((f) => f.ext.map((e) => '.' + e)).concat([...AUX_EXT].map((e) => '.' + e)).join(',');

/** Picks the main model file out of a dropped/selected set */
export function pickMainFile(files) {
  const list = [...files];
  // prefer 3D/2D models over auxiliary files
  return list.find((f) => formatOf(f.name)) || null;
}

/**
 * Loads a model file.
 * @param {File} file main file
 * @param {File[]} siblings all files of the selection (for OBJ+MTL, glTF+bin+textures)
 * @param {(msg:string)=>void} onProgress
 * @returns {Promise<{object: THREE.Object3D, kind: '3d'|'2d', format: object, drawing?: object}>}
 */
export async function loadFile(file, siblings = [], onProgress = () => {}) {
  const format = formatOf(file.name);
  if (!format) throw new Error(`지원하지 않는 파일 형식입니다: ${file.name}`);
  onProgress(`${file.name} 읽는 중...`);
  const buffer = await file.arrayBuffer();

  if (format.kind === '2d') {
    const res = await loadCad2D(format.key, buffer, onProgress);
    return { ...res, kind: '2d', format };
  }
  if (['step', 'iges', 'brep'].includes(format.key)) {
    const object = await loadOcct(format.key, buffer, onProgress, file.name);
    return { object, kind: '3d', format };
  }

  onProgress(`${format.label} 변환 중...`);
  const urlMap = new Map();
  for (const f of siblings) if (f !== file) urlMap.set(f.name.toLowerCase(), URL.createObjectURL(f));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    const base = decodeURIComponent(url.split(/[\\/]/).pop().split('?')[0]).toLowerCase();
    return urlMap.get(base) || url;
  });
  try {
    const object = await loadMesh(format.key, buffer, file, manager, siblings);
    object.name = object.name || file.name;
    if (format.yUp) object.rotation.x = Math.PI / 2; // Y-up -> Z-up
    return { object, kind: '3d', format };
  } finally {
    setTimeout(() => urlMap.forEach((u) => URL.revokeObjectURL(u)), 30000);
  }
}

const defaultMaterial = () => new THREE.MeshStandardMaterial({ color: 0xb8c2cc, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide });

function geometryToObject(geometry, name) {
  if (!geometry.index && !geometry.attributes.normal && geometry.attributes.position.count && isPointCloud(geometry)) {
    const mat = new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: !!geometry.attributes.color, color: geometry.attributes.color ? 0xffffff : 0x9ad0ff });
    const pts = new THREE.Points(geometry, mat);
    pts.name = name;
    return pts;
  }
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const mat = defaultMaterial();
  if (geometry.attributes.color) mat.vertexColors = true;
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = name;
  return mesh;
}

function isPointCloud(g) {
  return g.userData?.pointCloud === true;
}

async function loadMesh(key, buffer, file, manager, siblings) {
  const name = file.name.replace(/\.[^.]+$/, '');
  switch (key) {
    case 'stl': {
      const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
      const g = new STLLoader(manager).parse(buffer);
      const mesh = geometryToObject(g, name);
      if (g.hasColors) {
        mesh.material.vertexColors = true;
        mesh.material.opacity = g.alpha;
      }
      return wrap(mesh, file.name);
    }
    case 'obj': {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
      const loader = new OBJLoader(manager);
      const text = new TextDecoder().decode(buffer);
      const mtlName = /^mtllib\s+(.+)$/m.exec(text)?.[1]?.trim();
      const mtlFile = siblings.find((f) => extOf(f.name) === 'mtl' && (!mtlName || f.name.toLowerCase() === mtlName.split(/[\\/]/).pop().toLowerCase()))
        || siblings.find((f) => extOf(f.name) === 'mtl');
      if (mtlFile) {
        const { MTLLoader } = await import('three/examples/jsm/loaders/MTLLoader.js');
        const mtl = new MTLLoader(manager).parse(await mtlFile.text(), '');
        mtl.preload();
        loader.setMaterials(mtl);
      }
      return loader.parse(text);
    }
    case 'gltf': {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js');
      const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');
      const loader = new GLTFLoader(manager);
      const draco = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
      loader.setDRACOLoader(draco);
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.parseAsync(buffer, '');
      const root = gltf.scene || gltf.scenes[0];
      root.name = file.name;
      return root;
    }
    case 'fbx': {
      const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
      return new FBXLoader(manager).parse(buffer, '');
    }
    case 'ply': {
      const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
      const g = new PLYLoader(manager).parse(buffer);
      if (!g.index && !g.attributes.normal) g.userData.pointCloud = !hasFaces(buffer);
      return wrap(geometryToObject(g, name), file.name);
    }
    case '3mf': {
      const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js');
      return new ThreeMFLoader(manager).parse(buffer);
    }
    case 'dae': {
      const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js');
      const res = new ColladaLoader(manager).parse(new TextDecoder().decode(buffer), '');
      return res.scene;
    }
    case '3ds': {
      const { TDSLoader } = await import('three/examples/jsm/loaders/TDSLoader.js');
      return new TDSLoader(manager).parse(buffer, '');
    }
    case 'amf': {
      const { AMFLoader } = await import('three/examples/jsm/loaders/AMFLoader.js');
      return new AMFLoader(manager).parse(buffer);
    }
    case 'vrml': {
      const { VRMLLoader } = await import('three/examples/jsm/loaders/VRMLLoader.js');
      return new VRMLLoader(manager).parse(new TextDecoder().decode(buffer), '');
    }
    case 'vtk': {
      const { VTKLoader } = await import('three/examples/jsm/loaders/VTKLoader.js');
      const g = new VTKLoader(manager).parse(buffer, '');
      return wrap(geometryToObject(g, name), file.name);
    }
    case 'xyz': {
      const { XYZLoader } = await import('three/examples/jsm/loaders/XYZLoader.js');
      const g = new XYZLoader(manager).parse(new TextDecoder().decode(buffer));
      g.userData.pointCloud = true;
      return wrap(geometryToObject(g, name), file.name);
    }
    case 'pcd': {
      const { PCDLoader } = await import('three/examples/jsm/loaders/PCDLoader.js');
      const pts = new PCDLoader(manager).parse(buffer);
      pts.material.sizeAttenuation = false;
      pts.material.size = 2;
      return wrap(pts, file.name);
    }
    default:
      throw new Error('지원하지 않는 형식: ' + key);
  }
}

function hasFaces(buffer) {
  const head = new TextDecoder().decode(buffer.slice(0, Math.min(buffer.byteLength, 4096)));
  const m = /element\s+face\s+(\d+)/.exec(head);
  return !!m && +m[1] > 0;
}

function wrap(obj, name) {
  const g = new THREE.Group();
  g.name = name;
  g.add(obj);
  return g;
}
