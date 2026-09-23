import { Worker } from "node:worker_threads";
import type { MemoryRepository } from "./repository";

type Method = Exclude<keyof MemoryRepository, "close" | "runCancellable">;
export class MemoryDatabaseClient {
  private readonly worker: Worker;
  private sequence = 0;
  private stopped = false;
  private closing?: Promise<void>;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(workerPath: string, databasePath: string, private readonly timeoutMs = 15000) {
    this.worker = new Worker(workerPath, { workerData: { databasePath } });
    this.worker.on("message", (message: { id: number; result?: unknown; error?: string }) => {
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
    });
    this.worker.on("error", error => this.fail(error));
    this.worker.on("exit", () => this.fail(new Error("Memory database worker exited")));
  }
  private fail(error: Error) {
    this.stopped = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  async call<M extends Method>(method: M, ...args: Parameters<MemoryRepository[M]>): Promise<ReturnType<MemoryRepository[M]>> {
    return this.send(method, args) as Promise<ReturnType<MemoryRepository[M]>>;
  }
  scoped(signal: AbortSignal) {
    return { call: async <M extends Method>(method: M, ...args: Parameters<MemoryRepository[M]>): Promise<ReturnType<MemoryRepository[M]>> => {
      signal.throwIfAborted();
      const cancellation = new Int32Array(new SharedArrayBuffer(4));
      const abort = () => { Atomics.store(cancellation, 0, 1); Atomics.notify(cancellation, 0); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const result = await this.send(method, args, cancellation.buffer as SharedArrayBuffer);
        signal.throwIfAborted();
        return result as ReturnType<MemoryRepository[M]>;
      } finally { signal.removeEventListener("abort", abort); }
    } };
  }
  private send(method: string, args: unknown[], cancellation?: SharedArrayBuffer): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error("Memory database is closed"));
    if (this.pending.size >= 64) return Promise.reject(new Error("Memory database queue is full"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error("Memory database timed out; operation outcome is unknown"));
        void this.worker.terminate();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ id, method, args, cancellation }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  close(): Promise<void> {
    return this.closing ??= this.closeWorker();
  }
  private async closeWorker(): Promise<void> {
    if (this.stopped) return;
    const closing = this.send("close", []);
    this.stopped = true;
    const timer = setTimeout(() => { void this.worker.terminate(); }, 2000);
    try { await closing; }
    finally { clearTimeout(timer); await this.worker.terminate(); }
  }
}
