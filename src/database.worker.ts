import { parentPort, workerData } from "node:worker_threads";
import { MemoryRepository } from "./repository";

const repository = new MemoryRepository(workerData.databasePath);
const methods = new Set(["consolidate","clearVectors", "pendingVectors", "putVectors", "searchVectors", "list", "get", "history", "confirm", "importCandidates", "createSkillDraft", "readSkillDraft", "save", "move", "forget", "enqueue", "enqueueEvidence", "jobEvidence", "jobSettled", "claim", "finishJob", "commitJob", "cancelSessionJobs", "cancelRunJob", "forgetSession", "jobResult", "jobStatus"]);
parentPort!.on("message", ({ id, method, args, cancellation }: { id: number; method: string; args: unknown[]; cancellation?: SharedArrayBuffer }) => {
  try {
    if (method === "close") {
      repository.close();
      parentPort!.postMessage({ id, result: null });
      parentPort!.close();
      return;
    }
    if (!methods.has(method) || !Array.isArray(args)) throw new Error("Invalid database operation");
    const invoke = (repository as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!;
    const result = cancellation
      ? repository.runCancellable(() => invoke.apply(repository, args), new Int32Array(cancellation))
      : invoke.apply(repository, args);
    parentPort!.postMessage({ id, result });
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : "Database operation failed" });
  }
});

