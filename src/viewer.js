// Core viewer: scene, cameras, controls, render modes, section planes,
// explode / separation, selection and picking.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { ViewCube } from './ui/viewcube.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const Z_UP = new THREE.Vector3(0, 0, 1);
const HIGHLIGHT = new THREE.Color(0x2f7bff);

export const VIEWS = {
  front: new THREE.Vector3(0, -1, 0),
  back: new THREE.Vector3(0, 1, 0),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
  top: new THREE.Vector3(0, -1e-5, 1),
  bottom: new THREE.Vector3(0, -1e-5, -1),
  iso: new THREE.Vector3(1, -1, 1),
  isoNW: new THREE.Vector3(-1, 1, 1),
  isoSW: new THREE.Vector3(-1, -1, 1),
  isoNE: new THREE.Vector3(1, 1, 1),
};

export class Viewer extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.mode = 'empty'; // 'empty' | '3d' | '2d'
    this.renderMode = 'shaded-edges';
    this.selection = new Set();
    this.model = null;
    this.cad = null;
    this.parts = [];
    this.explodeFactor = 0;
    this.sections = { x: { on: false, pos: 0.5, flip: false }, y: { on: false, pos: 0.5, flip: false }, z: { on: false, pos: 0.5, flip: false } };
    this.clipPlanes = [];
    this.dirty = true;

    // ---------- renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.localClippingEnabled = true;
    renderer.autoClear = false;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label-layer';
    container.appendChild(this.labelRenderer.domElement);

    // ---------- scene
    const scene = new THREE.Scene();
    this.scene = scene;
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.7;

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x445566, 0.6);
    this.hemi.position.set(0, 0, 1);
    scene.add(this.hemi);
    this.headlight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.headlight.position.set(0.3, 0.5, 1);

    this.root = new THREE.Group(); // holds the loaded model
    this.root.name = '__root';
    scene.add(this.root);
    this.helpers = new THREE.Group();
    this.helpers.name = '__helpers';
    scene.add(this.helpers);
    this.overlay = new THREE.Group(); // measurement, highlight
    this.overlay.name = '__overlay';
    scene.add(this.overlay);

    // ---------- cameras
    const aspect = 1;
    this.perspCam = new THREE.PerspectiveCamera(40, aspect, 0.01, 1e7);
    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e7, 1e7);
    for (const c of [this.perspCam, this.orthoCam]) {
      c.up.copy(Z_UP);
      c.position.set(100, -100, 100);
      c.add(this.headlight.clone());
      scene.add(c);
    }
    this.camera = this.perspCam;

    // ---------- controls
    this.controls = this.createControls(this.camera);

    this.transform = new TransformControls(this.camera, renderer.domElement);
    this.transform.setSize(0.9);
    this.transform.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value;
      if (!e.value) this.onTransformEnd();
    });
    this.transform.addEventListener('change', () => this.requestRender());
    this.transform.addEventListener('objectChange', () => this.applyProxyDelta());
    scene.add(this.transform.getHelper());
    this.moveProxy = new THREE.Object3D();
    this.moveProxy.name = '__moveProxy';
    scene.add(this.moveProxy);

    // ---------- helpers
    this.grid = null;
    this.axes = new THREE.AxesHelper(1);
    this.axes.visible = false;
    this.helpers.add(this.axes);
    this.sectionHelpers = new THREE.Group();
    this.helpers.add(this.sectionHelpers);

    this.viewCube = new ViewCube(this);

    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;

    this.sceneBox = new THREE.Box3(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));
    this.sceneRadius = 100;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.setView('iso', false);
    this.lastTime = performance.now();
    this.animate = this.animate.bind(this);
    renderer.setAnimationLoop(this.animate);
  }

  // ================================================================ basics
  createControls(camera) {
    const c = new OrbitControls(camera, this.renderer.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.15;
    c.screenSpacePanning = true;
    c.zoomToCursor = true;
    c.rotateSpeed = 0.9;
    c.zoomSpeed = 1.2;
    c.maxDistance = 1e7;
    c.minDistance = 0;
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    c.addEventListener('change', () => this.requestRender());
    if (this.controls) {
      c.target.copy(this.controls.target);
      c.enableRotate = this.controls.enableRotate;
      c.mouseButtons = { ...this.controls.mouseButtons };
      this.controls.dispose();
    }
    return c;
  }

  requestRender() {
    this.dirty = true;
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.perspCam.aspect = w / h;
    this.perspCam.updateProjectionMatrix();
    this.updateOrthoFrustum();
    this.requestRender();
  }

  updateOrthoFrustum(halfH) {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    const cam = this.orthoCam;
    const hh = halfH ?? (cam.top - cam.bottom) / 2;
    cam.top = hh;
    cam.bottom = -hh;
    cam.left = (-hh * w) / h;
    cam.right = (hh * w) / h;
    cam.updateProjectionMatrix();
  }

  animate() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    if (this.tween) this.stepTween(dt);
    const changed = this.controls.update(dt);
    if (changed) this.dirty = true;
    if (this.viewCube.update()) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;

    // keep near/far sane relative to the zoom level
    const d = this.camera.position.distanceTo(this.controls.target);
    if (this.camera.isPerspectiveCamera) {
      this.camera.near = Math.max(d * 0.002, this.sceneRadius * 1e-6);
      this.camera.far = d + this.sceneRadius * 50;
      this.camera.updateProjectionMatrix();
    } else {
      this.camera.near = -this.sceneRadius * 50 - d;
      this.camera.far = this.sceneRadius * 50 + d;
      this.camera.updateProjectionMatrix();
    }
    this.dispatchEvent(new CustomEvent('render'));

    const r = this.renderer;
    r.setViewport(0, 0, this.container.clientWidth, this.container.clientHeight);
    r.setScissorTest(false);
    r.clear();
    r.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
    if (this.mode !== '2d') this.viewCube.render(r);
  }

  // ================================================================ model
  clear() {
    this.stopMove();
    this.clearSelection(true);
    for (const c of [...this.root.children]) {
      this.root.remove(c);
      disposeObject(c);
    }
    this.model = null;
    this.cad = null;
    this.parts = [];
    this.explodeFactor = 0;
    this.clearEntitySelection(true);
    this.sectionHelpers.clear();
    for (const k of 'xyz') this.sections[k].on = false;
    this.updateClipping();
    this.mode = 'empty';
    this.requestRender();
  }

  /** Adds a loaded 3D model */
  setModel(object) {
    this.clear();
    this.mode = '3d';
    this.model = object;
    this.root.add(object);
    prepareModel(object);
    this.parts = collectParts(object);
    this.root.updateMatrixWorld(true);
    this.storeBasePositions();
    this.applyRenderMode();
    this.updateSceneBox();
    this.rebuildGrid();
    this.setOrtho(false);
    this.controls.enableRotate = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.setView('iso', false);
    this.fit(false);
    this.dispatchEvent(new CustomEvent('model'));
  }

  /** Adds a 2D drawing */
  setDrawing(cad) {
    this.clear();
    this.mode = '2d';
    this.cad = cad;
    this.model = cad.group;
    this.root.add(cad.group);
    this.root.updateMatrixWorld(true);
    this.updateSceneBox();
    if (this.grid) this.grid.visible = false;
    this.setOrtho(true);
    this.controls.enableRotate = false;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.setView('top', false);
    this.fit(false);
    this.dispatchEvent(new CustomEvent('model'));
  }

  updateSceneBox() {
    const box = new THREE.Box3();
    if (this.model) {
      this.model.updateMatrixWorld(true);
      box.setFromObject(this.model, false);
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));
    this.sceneBox.copy(box);
    this.sceneRadius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-6);
    this.axes.scale.setScalar(this.sceneRadius * 0.6);
    return box;
  }

  rebuildGrid() {
    if (this.grid) {
      this.helpers.remove(this.grid);
      disposeObject(this.grid);
    }
    const box = this.sceneBox;
    const size = box.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y) * 2.5 || 100;
    const step = Math.pow(10, Math.floor(Math.log10(extent / 10)));
    const n = Math.ceil(extent / step / 2) * 2;
    const grid = new THREE.GridHelper(n * step, n, 0x6b7a90, 0x3a4556);
    grid.rotation.x = Math.PI / 2;
    const c = box.getCenter(new THREE.Vector3());
    grid.position.set(Math.round(c.x / step) * step, Math.round(c.y / step) * step, box.min.z);
    grid.material.transparent = true;
    grid.material.opacity = 0.45;
    grid.material.depthWrite = false;
    grid.renderOrder = -10;
    grid.visible = this.gridVisible ?? true;
    grid.userData.step = step;
    this.grid = grid;
    this.helpers.add(grid);
  }

  setGridVisible(v) {
    this.gridVisible = v;
    if (this.grid) this.grid.visible = v && this.mode === '3d';
    this.requestRender();
  }

  setAxesVisible(v) {
    this.axes.visible = v;
    this.requestRender();
  }

  // ================================================================ camera
  setOrtho(ortho) {
    const from = this.camera;
    const to = ortho ? this.orthoCam : this.perspCam;
    if (from === to) return;
    const target = this.controls.target.clone();
    const dir = from.position.clone().sub(target);
    let dist = dir.length();
    if (ortho) {
      // match visible height at target
      const halfH = dist * Math.tan(THREE.MathUtils.degToRad(this.perspCam.fov / 2));
      this.orthoCam.zoom = 1;
      this.updateOrthoFrustum(halfH);
      to.position.copy(target).add(dir.normalize().multiplyScalar(Math.max(dist, this.sceneRadius * 4)));
    } else {
      const halfH = (this.orthoCam.top - this.orthoCam.bottom) / 2 / this.orthoCam.zoom;
      dist = halfH / Math.tan(THREE.MathUtils.degToRad(this.perspCam.fov / 2));
      to.position.copy(target).add(dir.normalize().multiplyScalar(dist));
    }
    to.quaternion.copy(from.quaternion);
    to.up.copy(Z_UP);
    this.camera = to;
    this.controls = this.createControls(to);
    this.controls.target.copy(target);
    this.transform.camera = to;
    this.controls.update();
    this.dispatchEvent(new CustomEvent('camera'));
    this.requestRender();
  }

  get isOrtho() {
    return this.camera === this.orthoCam;
  }

  /** visible box for fitting (visible meshes only) */
  visibleBox(objects) {
    const box = new THREE.Box3();
    const list = objects && objects.length ? objects : [this.model];
    for (const o of list) {
      if (!o) continue;
      o.updateWorldMatrix(true, true);
      o.traverseVisible((c) => {
        if (c.userData.helper || c.name === '__edges') return;
        if (c.isMesh || c.isLine || c.isPoints) {
          if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
          box.union(c.geometry.boundingBox.clone().applyMatrix4(c.matrixWorld));
        }
      });
    }
    return box;
  }

  fit(animate = true, objects = null) {
    let box = objects && objects.isBox3 ? objects : this.visibleBox(objects);
    if (box.isEmpty()) box = this.sceneBox;
    this.fitBox(box, animate);
  }

  fitBox(box, animate = true) {
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-6);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (!isFinite(dir.x) || dir.lengthSq() < 0.5) dir.set(1, -1, 1).normalize();
    const cam = this.camera;
    let pos, zoom = 1;
    if (cam.isPerspectiveCamera) {
      const fov = THREE.MathUtils.degToRad(cam.fov);
      const fitH = radius / Math.sin(fov / 2);
      const fitW = radius / Math.sin(Math.atan(Math.tan(fov / 2) * cam.aspect));
      pos = center.clone().add(dir.multiplyScalar(Math.max(fitH, fitW) * 1.05));
    } else {
      const aspect = (this.container.clientWidth || 1) / (this.container.clientHeight || 1);
      let halfH = radius * 1.05;
      if (this.mode === '2d') {
        // tighter fit for flat drawings
        const s = box.getSize(new THREE.Vector3());
        halfH = Math.max(s.y / 2, s.x / 2 / aspect) * 1.08 || 1;
      }
      const curHalf = (cam.top - cam.bottom) / 2;
      zoom = curHalf / halfH;
      pos = center.clone().add(dir.multiplyScalar(Math.max(radius * 4, 1)));
    }
    this.animateCamera(pos, center, zoom, animate);
  }

  animateCamera(pos, target, zoom, animate = true) {
    const cam = this.camera;
    if (!animate) {
      cam.position.copy(pos);
      this.controls.target.copy(target);
      if (cam.isOrthographicCamera) {
        cam.zoom = zoom;
        cam.updateProjectionMatrix();
      }
      this.controls.update();
      this.requestRender();
      return;
    }
    this.tween = {
      t: 0, dur: 0.35,
      p0: cam.position.clone(), p1: pos.clone(),
      t0: this.controls.target.clone(), t1: target.clone(),
      z0: cam.zoom, z1: cam.isOrthographicCamera ? zoom : cam.zoom,
    };
  }

  stepTween(dt) {
    const tw = this.tween;
    tw.t = Math.min(1, tw.t + dt / tw.dur);
    const k = 1 - Math.pow(1 - tw.t, 3);
    const cam = this.camera;
    // interpolate around the target so views swing instead of cutting through the model
    const tgt = tw.t0.clone().lerp(tw.t1, k);
    const v0 = tw.p0.clone().sub(tw.t0), v1 = tw.p1.clone().sub(tw.t1);
    const l = THREE.MathUtils.lerp(v0.length(), v1.length(), k);
    const dir = slerpDir(v0.normalize(), v1.normalize(), k);
    cam.position.copy(tgt).add(dir.multiplyScalar(l));
    this.controls.target.copy(tgt);
    if (cam.isOrthographicCamera) {
      cam.zoom = Math.exp(THREE.MathUtils.lerp(Math.log(tw.z0), Math.log(tw.z1), k));
      cam.updateProjectionMatrix();
    }
    cam.lookAt(tgt);
    this.dirty = true;
    if (tw.t >= 1) this.tween = null;
  }

  setView(name, animate = true) {
    const dir = (VIEWS[name] || VIEWS.iso).clone().normalize();
    this.setViewDir(dir, animate);
  }

  setViewDir(dir, animate = true) {
    if (Math.abs(dir.z) > 0.9999) dir = new THREE.Vector3(0, -1e-5, Math.sign(dir.z)).normalize();
    const target = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(target) || this.sceneRadius * 3;
    const pos = target.clone().add(dir.clone().multiplyScalar(dist));
    this.animateCamera(pos, target, this.camera.zoom, animate);
    if (!animate) this.camera.lookAt(target);
  }

  /** orbit center to a picked point */
  setPivot(point) {
    const offset = point.clone().sub(this.controls.target);
    this.animateCamera(this.camera.position.clone().add(offset), point, this.camera.zoom, true);
  }

  // ================================================================ picking
  pick(clientX, clientY, { lines = this.mode === '2d' } = {}) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const wpp = this.worldPerPixel();
    this.raycaster.params.Line.threshold = wpp * 5;
    this.raycaster.params.Points.threshold = wpp * 5;
    if (!this.model) return null;
    const hits = this.raycaster.intersectObject(this.model, true).filter((h) => {
      if (!isVisibleDeep(h.object) || h.object.userData.helper || h.object.name === '__edges') return false;
      if (!lines && (h.object.isLine || h.object.isLineSegments)) return false;
      if (this.clipPlanes.length && !this.clipPlanes.every((p) => p.distanceToPoint(h.point) >= -1e-9)) return false;
      return true;
    });
    if (!hits.length) return null;
    if (this.mode === '2d') {
      // prefer lines / texts over fills underneath
      const pri = (h) => (h.object.isLineSegments ? 0 : h.object.userData.isText ? 1 : h.object.isPoints ? 0 : 2);
      hits.sort((a, b) => pri(a) - pri(b) || a.distance - b.distance);
    }
    return hits[0];
  }

  /** ray against the z=0 plane / view plane through target */
  pickPlane(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const n = this.mode === '2d' ? Z_UP.clone() : this.camera.getWorldDirection(new THREE.Vector3()).negate();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, this.mode === '2d' ? new THREE.Vector3() : this.controls.target);
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, p) ? p : null;
  }

  worldPerPixel() {
    const h = this.container.clientHeight || 1;
    if (this.camera.isOrthographicCamera) return (this.camera.top - this.camera.bottom) / this.camera.zoom / h;
    const d = this.camera.position.distanceTo(this.controls.target);
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / h;
  }

  toScreen(p) {
    const v = p.clone().project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: ((v.x + 1) / 2) * rect.width, y: ((1 - v.y) / 2) * rect.height };
  }

  /** returns the selectable node for a picked mesh (honours pick level) */
  selectableFor(obj) {
    let o = obj;
    while (o && o.name === '__edges') o = o.parent;
    if (this.pickLevel === 'assembly') {
      // climb to the direct child of the model root
      while (o && o.parent && o.parent !== this.model) o = o.parent;
    }
    return o;
  }

  // ================================================================ selection
  select(objs, additive = false) {
    if (!additive) this.clearSelection(true);
    for (const o of objs) {
      if (!o) continue;
      if (additive && this.selection.has(o)) {
        this.selection.delete(o);
        setHighlight(o, false, this.edgeColor());
      } else {
        this.selection.add(o);
        setHighlight(o, true, this.edgeColor());
      }
    }
    this.updateHighlights();
    this.dispatchEvent(new CustomEvent('selection'));
    this.requestRender();
  }

  clearSelection(silent = false) {
    for (const o of this.selection) setHighlight(o, false, this.edgeColor());
    this.selection.clear();
    this.stopMove();
    this.updateHighlights();
    if (!silent) this.dispatchEvent(new CustomEvent('selection'));
    this.requestRender();
  }

  updateHighlights() {
    // re-apply in case a parent and child are both selected
    for (const o of this.selection) setHighlight(o, true, this.edgeColor());
  }

  edgeColor() {
    return this.renderMode === 'xray' ? 0x9fb8d8 : this.renderMode === 'edges' ? 0xd8e2ee : 0x1b2430;
  }

  // ---------- 2D entity selection
  selectEntity(id, additive = false) {
    if (!additive) this.clearEntitySelection(true);
    this.entitySel = this.entitySel || new Map();
    if (this.entitySel.has(id)) {
      const g = this.entitySel.get(id);
      this.overlay.remove(g);
      disposeObject(g);
      this.entitySel.delete(id);
    } else {
      const g = this.cad.buildHighlight(id);
      if (g) {
        this.overlay.add(g);
        this.entitySel.set(id, g);
      }
    }
    this.dispatchEvent(new CustomEvent('selection'));
    this.requestRender();
  }

  clearEntitySelection(silent = false) {
    if (this.entitySel) {
      for (const g of this.entitySel.values()) {
        this.overlay.remove(g);
        disposeObject(g);
      }
      this.entitySel.clear();
    }
    if (!silent) this.dispatchEvent(new CustomEvent('selection'));
    this.requestRender();
  }

  // ================================================================ visibility
  hide(objs) {
    for (const o of objs) o.visible = false;
    this.afterVisibilityChange();
  }

  isolate(objs) {
    if (!this.model || !objs.length) return;
    const keep = new Set();
    for (const o of objs) {
      o.traverse((c) => keep.add(c));
      let p = o.parent;
      while (p) { keep.add(p); p = p.parent; }
    }
    this.model.traverse((c) => {
      if (c.name === '__edges' || c.userData.helper) return;
      c.visible = keep.has(c);
    });
    this.afterVisibilityChange();
  }

  showAll() {
    if (!this.model) return;
    this.model.traverse((c) => {
      if (c.name === '__edges') c.visible = this.renderMode !== 'shaded';
      else if (!c.userData.helper) c.visible = true;
    });
    if (this.cad) for (const l of this.cad.layers.values()) this.cad.setLayerVisible(l.name, true);
    this.afterVisibilityChange();
  }

  afterVisibilityChange() {
    this.applyRenderMode();
    this.dispatchEvent(new CustomEvent('visibility'));
    this.requestRender();
  }

  // ================================================================ render modes
  setRenderMode(mode) {
    this.renderMode = mode;
    this.applyRenderMode();
  }

  applyRenderMode() {
    if (this.mode !== '3d' || !this.model) return;
    const mode = this.renderMode;
    const needEdges = mode === 'shaded-edges' || mode === 'edges' || mode === 'xray';
    this.model.traverse((o) => {
      if (!o.isMesh || o.name === '__edges' || o.userData.helper) return;
      if (needEdges) ensureEdges(o);
      const edges = o.children.find((c) => c.name === '__edges');
      if (edges) {
        edges.visible = needEdges;
        edges.material.color.set(this.edgeColor());
        edges.material.opacity = mode === 'xray' ? 0.35 : 1;
        edges.material.transparent = mode === 'xray';
      }
      forEachMaterial(o, (m) => {
        const orig = m.userData.orig;
        m.wireframe = mode === 'wireframe';
        m.colorWrite = mode !== 'edges';
        m.depthWrite = mode === 'xray' ? false : orig.depthWrite;
        m.transparent = mode === 'xray' ? true : orig.transparent || (o.userData.opacity ?? 1) < 1;
        m.opacity = mode === 'xray' ? 0.18 : orig.opacity * (o.userData.opacity ?? 1);
        m.needsUpdate = true;
      });
      o.renderOrder = mode === 'xray' ? 1 : 0;
    });
    this.updateHighlights();
    this.requestRender();
  }

  setPartOpacity(objs, opacity) {
    for (const o of objs)
      o.traverse((c) => {
        if (c.isMesh && c.name !== '__edges') c.userData.opacity = opacity;
      });
    this.applyRenderMode();
  }

  setPartColor(objs, hex) {
    for (const o of objs)
      o.traverse((c) => {
        if (!c.isMesh || c.name === '__edges') return;
        forEachMaterial(c, (m) => {
          if (m.color) m.color.set(hex);
          m.vertexColors = false;
          m.map = null;
          m.needsUpdate = true;
        });
      });
    this.updateHighlights();
    this.requestRender();
  }

  resetPartColor(objs) {
    for (const o of objs)
      o.traverse((c) => {
        if (!c.isMesh || c.name === '__edges') return;
        forEachMaterial(c, (m) => {
          const orig = m.userData.orig;
          if (m.color && orig.color) m.color.copy(orig.color);
          m.vertexColors = orig.vertexColors;
          m.map = orig.map;
          m.needsUpdate = true;
        });
      });
    this.requestRender();
  }

  // ================================================================ section
  setSection(axis, opts) {
    Object.assign(this.sections[axis], opts);
    this.updateClipping();
  }

  updateClipping() {
    const box = this.sceneBox;
    this.clipPlanes = [];
    this.sectionHelpers.clear();
    const size = box.getSize(new THREE.Vector3());
    for (const [axis, s] of Object.entries(this.sections)) {
      if (!s.on || this.mode !== '3d') continue;
      const i = 'xyz'.indexOf(axis);
      const n = new THREE.Vector3();
      n.setComponent(i, s.flip ? 1 : -1);
      const pos = box.min.getComponent(i) + size.getComponent(i) * s.pos;
      const plane = new THREE.Plane(n, s.flip ? -pos : pos);
      this.clipPlanes.push(plane);
      if (this.showSectionPlane !== false) {
        const dims = [size.x, size.y, size.z].map((v) => v * 1.15 || 1);
        const geo = new THREE.PlaneGeometry(i === 0 ? dims[1] : dims[0], i === 2 ? dims[1] : dims[2]);
        const mat = new THREE.MeshBasicMaterial({ color: [0xff5a5a, 0x5aff8a, 0x5a9cff][i], transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false });
        const mesh = new THREE.Mesh(geo, mat);
        const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: [0xff5a5a, 0x5aff8a, 0x5a9cff][i], transparent: true, opacity: 0.8 }));
        mesh.add(edge);
        const c = box.getCenter(new THREE.Vector3());
        c.setComponent(i, pos);
        mesh.position.copy(c);
        if (i === 0) mesh.rotation.set(Math.PI / 2, Math.PI / 2, 0);
        else if (i === 1) mesh.rotation.set(Math.PI / 2, 0, 0);
        mesh.userData.helper = true;
        mesh.raycast = () => {};
        edge.raycast = () => {};
        this.sectionHelpers.add(mesh);
      }
    }
    if (this.model && this.mode === '3d') {
      this.model.traverse((o) => {
        if (!o.material) return;
        forEachMaterial(o, (m) => {
          m.clippingPlanes = this.clipPlanes.length ? this.clipPlanes : null;
          m.clipIntersection = false;
          m.needsUpdate = true;
        });
      });
    }
    this.requestRender();
  }

  // ================================================================ explode / separation
  storeBasePositions(force = true) {
    this.model.traverse((o) => {
      if (!force && o.userData.basePos) return;
      o.userData.basePos = o.position.clone();
      o.userData.baseQuat = o.quaternion.clone();
    });
    this.computeExplodeDirs();
  }

  computeExplodeDirs() {
    // explode vectors (world space) from model center
    this.model.updateMatrixWorld(true);
    const center = this.visibleBox().getCenter(new THREE.Vector3());
    for (const p of this.parts) {
      const box = new THREE.Box3().setFromObject(p);
      const c = box.getCenter(new THREE.Vector3());
      p.userData.explodeDir = c.sub(center);
    }
  }

  setExplode(factor) {
    this.explodeFactor = factor;
    for (const p of this.parts) {
      const dirW = p.userData.explodeDir.clone().multiplyScalar(factor);
      // world offset -> parent local
      const parent = p.parent;
      const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
      const o0 = new THREE.Vector3().applyMatrix4(inv);
      const o1 = dirW.applyMatrix4(inv);
      const local = o1.sub(o0);
      const moved = p.userData.manualOffset || new THREE.Vector3();
      p.position.copy(p.userData.basePos).add(moved).add(local);
    }
    this.model.updateMatrixWorld(true);
    this.requestRender();
  }

  /** attach the move gizmo to the current selection (first item) */
  startMove(mode = 'translate') {
    const o = [...this.selection][0];
    if (!o) return false;
    // the gizmo drives a proxy placed at the part's centre; its delta is applied to the part
    o.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(o);
    this.moveProxy.position.copy(box.isEmpty() ? o.getWorldPosition(new THREE.Vector3()) : box.getCenter(new THREE.Vector3()));
    this.moveProxy.quaternion.identity();
    this.moveProxy.scale.set(1, 1, 1);
    this.moveProxy.updateMatrixWorld(true);
    this.moveTarget = o;
    this.moveStart = { proxyInv: this.moveProxy.matrixWorld.clone().invert(), objWorld: o.matrixWorld.clone() };
    this.transform.setMode(mode);
    this.transform.attach(this.moveProxy);
    this.requestRender();
    return true;
  }

  stopMove() {
    this.transform.detach();
    this.moveTarget = null;
    this.requestRender();
  }

  applyProxyDelta() {
    const o = this.moveTarget;
    if (!o || !this.moveStart) return;
    this.moveProxy.updateMatrixWorld(true);
    const delta = this.moveProxy.matrixWorld.clone().multiply(this.moveStart.proxyInv);
    const world = delta.multiply(this.moveStart.objWorld);
    const local = new THREE.Matrix4().copy(o.parent.matrixWorld).invert().multiply(world);
    local.decompose(o.position, o.quaternion, o.scale);
    o.updateMatrixWorld(true);
  }

  onTransformEnd() {
    const o = this.moveTarget;
    if (!o) return;
    this.applyProxyDelta();
    // remember manual displacement relative to base (+ current explode offset)
    const exploded = o.position.clone();
    o.userData.manualOffset = new THREE.Vector3();
    this.setExplode(this.explodeFactor);
    const withoutManual = o.position.clone();
    o.userData.manualOffset = exploded.sub(withoutManual);
    o.position.add(o.userData.manualOffset);
    o.updateMatrixWorld(true);
    this.moveProxy.updateMatrixWorld(true);
    this.moveStart = { proxyInv: this.moveProxy.matrixWorld.clone().invert(), objWorld: o.matrixWorld.clone() };
    this.dispatchEvent(new CustomEvent('transform'));
  }

  resetPositions() {
    if (!this.model) return;
    this.stopMove();
    this.model.traverse((o) => {
      if (o.userData.basePos) o.position.copy(o.userData.basePos);
      if (o.userData.baseQuat) o.quaternion.copy(o.userData.baseQuat);
      delete o.userData.manualOffset;
    });
    this.explodeFactor = 0;
    this.model.updateMatrixWorld(true);
    this.dispatchEvent(new CustomEvent('transform'));
    this.requestRender();
  }

  /** replaces a mesh by a group of sub-meshes and refreshes part bookkeeping */
  replaceObject(oldObj, newObj) {
    const factor = this.explodeFactor;
    this.setExplode(0);
    const parent = oldObj.parent;
    const idx = parent.children.indexOf(oldObj);
    newObj.position.copy(oldObj.position);
    newObj.quaternion.copy(oldObj.quaternion);
    newObj.scale.copy(oldObj.scale);
    parent.children.splice(idx, 1, newObj);
    newObj.parent = parent;
    oldObj.parent = null;
    this.selection.delete(oldObj);
    prepareModel(newObj);
    newObj.userData.basePos = oldObj.userData.basePos?.clone() || newObj.position.clone();
    newObj.userData.baseQuat = oldObj.userData.baseQuat?.clone() || newObj.quaternion.clone();
    newObj.userData.manualOffset = oldObj.userData.manualOffset;
    newObj.traverse((c) => {
      if (c === newObj) return;
      c.userData.basePos = c.position.clone();
      c.userData.baseQuat = c.quaternion.clone();
    });
    disposeObject(oldObj);
    this.parts = collectParts(this.model);
    this.storeBasePositions(false);
    this.setExplode(factor);
    this.applyRenderMode();
    this.updateClipping();
    this.dispatchEvent(new CustomEvent('model-structure'));
    this.requestRender();
  }

  // ================================================================ misc
  setBackground(css, light) {
    this.container.style.background = css;
    this.lightBackground = light;
    if (this.cad) this.cad.setLightBackground(light);
    if (this.grid) {
      this.grid.material.color?.set?.(light ? 0x8a96a8 : 0x3a4556);
    }
    this.requestRender();
  }

  screenshot(bgColor) {
    const r = this.renderer;
    const prevBg = this.scene.background;
    if (bgColor) this.scene.background = new THREE.Color(bgColor);
    r.clear();
    r.render(this.scene, this.camera);
    const url = r.domElement.toDataURL('image/png');
    this.scene.background = prevBg;
    this.requestRender();
    return url;
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.renderer.dispose();
  }
}

// ==================================================================== utils
function slerpDir(a, b, t) {
  const dot = THREE.MathUtils.clamp(a.dot(b), -1, 1);
  if (dot > 0.9995) return a.clone().lerp(b, t).normalize();
  if (dot < -0.9995) {
    // opposite: rotate around an arbitrary perpendicular (prefer Z-up)
    const axis = Math.abs(a.z) < 0.9 ? new THREE.Vector3().crossVectors(a, Z_UP).normalize() : new THREE.Vector3(1, 0, 0);
    return a.clone().applyAxisAngle(axis, Math.PI * t);
  }
  const theta = Math.acos(dot) * t;
  const rel = b.clone().sub(a.clone().multiplyScalar(dot)).normalize();
  return a.clone().multiplyScalar(Math.cos(theta)).add(rel.multiplyScalar(Math.sin(theta)));
}

export function forEachMaterial(o, fn) {
  if (!o.material) return;
  if (Array.isArray(o.material)) o.material.forEach(fn);
  else fn(o.material);
}

export function isVisibleDeep(o) {
  while (o) {
    if (!o.visible) return false;
    o = o.parent;
  }
  return true;
}

let uid = 0;
/** clones materials per mesh, records originals, builds BVH */
export function prepareModel(root) {
  root.traverse((o) => {
    if (o.userData.uid == null) o.userData.uid = ++uid;
    if (o.name === '__edges') return;
    if (!o.name) o.name = o.isMesh ? `Mesh ${o.userData.uid}` : o.isGroup ? `Group ${o.userData.uid}` : o.type;
    if (o.isMesh || o.isPoints || o.isLine) {
      if (o.userData.prepared) return;
      o.userData.prepared = true;
      const cloneMat = (m) => {
        let c = m.clone();
        // promote basic/phong/lambert to standard for consistent lighting & highlight support
        if (o.isMesh && !c.isMeshStandardMaterial && !c.isMeshPhysicalMaterial && (c.isMeshPhongMaterial || c.isMeshLambertMaterial || c.isMeshBasicMaterial)) {
          const s = new THREE.MeshStandardMaterial({
            color: c.color, map: c.map, vertexColors: c.vertexColors, transparent: c.transparent, opacity: c.opacity,
            side: THREE.DoubleSide, metalness: 0.1, roughness: 0.6, alphaTest: c.alphaTest,
          });
          s.name = c.name;
          c = s;
        }
        if (o.isMesh) c.side = THREE.DoubleSide;
        c.userData.orig = {
          color: c.color ? c.color.clone() : null,
          emissive: c.emissive ? c.emissive.clone() : null,
          opacity: c.opacity, transparent: c.transparent, depthWrite: c.depthWrite,
          vertexColors: c.vertexColors, map: c.map || null,
        };
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(cloneMat) : cloneMat(o.material);
      const g = o.geometry;
      if (o.isMesh && g) {
        if (!g.attributes.normal) g.computeVertexNormals();
        if (!g.boundsTree && g.attributes.position.count > 0) {
          try { g.computeBoundsTree(); } catch { /* ignore */ }
        }
        if (!g.boundingBox) g.computeBoundingBox();
      }
    }
  });
}

/** leaf parts used for explode: meshes (or groups of a single-level assembly) */
export function collectParts(root) {
  const parts = [];
  root.traverse((o) => {
    if ((o.isMesh || o.isPoints) && o.name !== '__edges' && !o.userData.helper) parts.push(o);
  });
  return parts;
}

function ensureEdges(mesh) {
  if (mesh.children.some((c) => c.name === '__edges')) return;
  const g = mesh.geometry;
  if (!g?.attributes.position) return;
  if (g.attributes.position.count > 3_000_000) return; // too large
  const eg = new THREE.EdgesGeometry(g, 25);
  const mat = new THREE.LineBasicMaterial({ color: 0x1b2430 });
  const firstMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  mat.clippingPlanes = firstMat.clippingPlanes;
  const edges = new THREE.LineSegments(eg, mat);
  edges.name = '__edges';
  edges.userData.helper = true;
  edges.raycast = () => {};
  mesh.add(edges);
}

function setHighlight(obj, on, edgeBase = 0x1b2430) {
  obj.traverse((o) => {
    if (!o.isMesh || o.name === '__edges') return;
    forEachMaterial(o, (m) => {
      if (m.emissive) {
        if (on) m.emissive.copy(HIGHLIGHT).multiplyScalar(0.55);
        else if (m.userData.orig?.emissive) m.emissive.copy(m.userData.orig.emissive);
        else m.emissive.set(0);
      }
    });
    const edges = o.children.find((c) => c.name === '__edges');
    if (edges) edges.material.color.set(on ? 0x7fb2ff : edgeBase);
  });
}

export function disposeObject(obj, keepGeometry = false) {
  obj.traverse((o) => {
    if (o.geometry && !keepGeometry) {
      o.geometry.disposeBoundsTree?.();
      o.geometry.dispose();
    }
    if (o.material) forEachMaterial(o, (m) => {
      m.map?.dispose?.();
      m.dispose();
    });
  });
}
