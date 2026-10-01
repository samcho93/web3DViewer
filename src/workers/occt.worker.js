// STEP / IGES / BREP import via OpenCascade (occt-import-js, WASM) in a worker
import occtimportjs from 'occt-import-js';
import wasmUrl from '../../node_modules/occt-import-js/dist/occt-import-js.wasm?url';

let occtPromise = null;
function getOcct() {
  if (!occtPromise) occtPromise = occtimportjs({ locateFile: () => wasmUrl });
  return occtPromise;
}

self.onmessage = async (e) => {
  const { id, format, buffer, params } = e.data;
  try {
    const occt = await getOcct();
    const content = new Uint8Array(buffer);
    const p = {
      linearUnit: 'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: params?.linearDeflection ?? 0.001,
      angularDeflection: params?.angularDeflection ?? 0.5,
    };
    let result;
    if (format === 'step') result = occt.ReadStepFile(content, p);
    else if (format === 'iges') result = occt.ReadIgesFile(content, p);
    else if (format === 'brep') result = occt.ReadBrepFile(content, p);
    else throw new Error('Unsupported format: ' + format);
    if (!result || !result.success) throw new Error('OpenCascade 변환 실패 (파일이 손상되었거나 지원하지 않는 형식)');

    // Convert plain arrays to typed arrays and transfer them
    const transfer = [];
    const meshes = result.meshes.map((m) => {
      const pos = new Float32Array(m.attributes.position.array);
      const nor = m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null;
      const idx = m.index ? new Uint32Array(m.index.array) : null;
      transfer.push(pos.buffer);
      if (nor) transfer.push(nor.buffer);
      if (idx) transfer.push(idx.buffer);
      return { name: m.name, color: m.color || null, brepFaces: m.brep_faces || [], position: pos, normal: nor, index: idx };
    });
    self.postMessage({ id, ok: true, root: result.root, meshes }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
