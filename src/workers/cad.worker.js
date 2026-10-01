// DXF / DWG parsing in a worker -> normalized, tessellated drawing model
import DxfParser from 'dxf-parser';
import { normalizeDxf, normalizeDwg } from '../cad/normalize.js';

let dwgLibPromise = null;
async function getLibreDwg() {
  if (!dwgLibPromise) {
    dwgLibPromise = (async () => {
      const [{ LibreDwg, createModule }, { default: wasmUrl }] = await Promise.all([
        import('@mlightcad/libredwg-web'),
        import('../../node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm?url'),
      ]);
      const instance = await createModule({ locateFile: () => wasmUrl });
      return LibreDwg.createByWasmInstance(instance);
    })();
  }
  return dwgLibPromise;
}

function decodeText(buffer) {
  const bytes = new Uint8Array(buffer);
  // DXF files are usually ANSI (cp949 for Korean drawings) or UTF-8
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('euc-kr').decode(bytes);
    } catch {
      return new TextDecoder('latin1').decode(bytes);
    }
  }
}

self.onmessage = async (e) => {
  const { id, format, buffer } = e.data;
  try {
    let drawing;
    if (format === 'dxf') {
      const text = decodeText(buffer);
      if (text.startsWith('AutoCAD Binary DXF')) throw new Error('바이너리 DXF는 지원하지 않습니다. ASCII DXF로 저장해 주세요.');
      const parsed = new DxfParser().parseSync(text);
      if (!parsed) throw new Error('DXF 파싱 실패');
      drawing = normalizeDxf(parsed);
    } else if (format === 'dwg') {
      const lib = await getLibreDwg();
      const ptr = lib.dwg_read_data(buffer, 0 /* Dwg_File_Type.DWG */);
      if (ptr == null) throw new Error('DWG 파일을 읽을 수 없습니다 (지원하지 않는 버전이거나 손상된 파일)');
      let db;
      try {
        db = lib.convert(ptr);
      } finally {
        try { lib.dwg_free(ptr); } catch { /* ignore */ }
      }
      drawing = normalizeDwg(db);
    } else {
      throw new Error('Unsupported format: ' + format);
    }
    self.postMessage({ id, ok: true, drawing });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
