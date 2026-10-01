// Tiny promise wrapper around a lazily created worker
export class WorkerClient {
  constructor(factory) {
    this.factory = factory;
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
  }

  ensure() {
    if (this.worker) return this.worker;
    this.worker = this.factory();
    this.worker.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data);
      else p.reject(new Error(e.data.error));
    };
    this.worker.onerror = (e) => {
      const err = new Error(e.message || '워커 오류');
      this.pending.forEach((p) => p.reject(err));
      this.pending.clear();
      this.worker.terminate();
      this.worker = null;
    };
    return this.worker;
  }

  call(msg, transfer = []) {
    const id = ++this.seq;
    const w = this.ensure();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ ...msg, id }, transfer);
    });
  }
}
