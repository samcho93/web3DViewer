// Navigation cube (top-right), Z-up. Click a face / corner to orient the view.
import * as THREE from 'three';

const SIZE = 110;
const MARGIN = 8;

function faceTexture(label) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#e8edf3';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#8a97a8';
  g.lineWidth = 6;
  g.strokeRect(3, 3, 122, 122);
  g.fillStyle = '#2a3442';
  g.font = 'bold 26px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 64, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ViewCube {
  constructor(viewer) {
    this.viewer = viewer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-0.95, 0.95, 0.95, -0.95, 0.1, 10);
    this.targets = [];
    this.hovered = null;
    this.visible = true;

    const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    const qz = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a);
    const faces = [
      { label: 'TOP', dir: [0, 0, 1], q: new THREE.Quaternion() },
      { label: 'BOTTOM', dir: [0, 0, -1], q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI) },
      { label: 'FRONT', dir: [0, -1, 0], q: qx.clone() },
      { label: 'BACK', dir: [0, 1, 0], q: qz(Math.PI).multiply(qx) },
      { label: 'RIGHT', dir: [1, 0, 0], q: qz(Math.PI / 2).multiply(qx) },
      { label: 'LEFT', dir: [-1, 0, 0], q: qz(-Math.PI / 2).multiply(qx) },
    ];
    const plane = new THREE.PlaneGeometry(1, 1);
    for (const f of faces) {
      const m = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: faceTexture(f.label), toneMapped: false }));
      m.quaternion.copy(f.q);
      m.position.set(...f.dir).multiplyScalar(0.5);
      m.userData.dir = new THREE.Vector3(...f.dir);
      this.scene.add(m);
      this.targets.push(m);
    }
    // corners -> isometric views
    const cornerGeo = new THREE.SphereGeometry(0.13, 12, 8);
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      const m = new THREE.Mesh(cornerGeo, new THREE.MeshBasicMaterial({ color: 0x9fb0c4, toneMapped: false }));
      m.position.set(x, y, z).multiplyScalar(0.5);
      m.userData.dir = new THREE.Vector3(x, y, z).normalize();
      m.userData.corner = true;
      this.scene.add(m);
      this.targets.push(m);
    }
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0x5b6878 }));
    this.scene.add(edges);
    // small axis triad
    const axes = new THREE.AxesHelper(0.85);
    axes.position.set(-0.5, -0.5, -0.5);
    this.scene.add(axes);
    this.raycaster = new THREE.Raycaster();
  }

  rect() {
    const el = this.viewer.renderer.domElement;
    const w = el.clientWidth;
    return { left: w - SIZE - MARGIN, top: MARGIN, size: SIZE };
  }

  hitTest(clientX, clientY) {
    if (!this.visible || this.viewer.mode === '2d') return null;
    const el = this.viewer.renderer.domElement.getBoundingClientRect();
    const r = this.rect();
    const x = clientX - el.left - r.left, y = clientY - el.top - r.top;
    if (x < 0 || y < 0 || x > r.size || y > r.size) return null;
    const ndc = new THREE.Vector2((x / r.size) * 2 - 1, -(y / r.size) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.targets, false)[0];
    return hit ? hit.object : 'inside';
  }

  hover(clientX, clientY) {
    const t = this.hitTest(clientX, clientY);
    const obj = t && t !== 'inside' ? t : null;
    if (obj === this.hovered) return !!t;
    if (this.hovered) this.hovered.material.color.set(this.hovered.userData.corner ? 0x9fb0c4 : 0xffffff);
    this.hovered = obj;
    if (obj) obj.material.color.set(obj.userData.corner ? 0x3d8bff : 0x9cc3ff);
    this.viewer.requestRender();
    return !!t;
  }

  click(clientX, clientY) {
    const t = this.hitTest(clientX, clientY);
    if (!t) return false;
    if (t !== 'inside') this.viewer.setViewDir(t.userData.dir.clone(), true);
    return true;
  }

  update() {
    return false;
  }

  render(renderer) {
    if (!this.visible) return;
    const cam = this.viewer.camera;
    const dir = cam.position.clone().sub(this.viewer.controls.target).normalize();
    this.camera.position.copy(dir.multiplyScalar(3));
    this.camera.quaternion.copy(cam.quaternion);
    this.camera.updateMatrixWorld();
    const el = renderer.domElement;
    const h = el.clientHeight, w = el.clientWidth;
    const x = w - SIZE - MARGIN, y = h - SIZE - MARGIN;
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, SIZE, SIZE);
    renderer.setViewport(x, y, SIZE, SIZE);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
  }
}
