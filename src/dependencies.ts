import { open } from "@modera/plugin-sdk/workspace-fs";
import { createHash } from "node:crypto";
import { readTarget } from "@modera/plugin-sdk";

export interface FileDependency { path: string; sha256: string }
export async function captureDependencies(workspace: string, paths: readonly string[], signal: AbortSignal): Promise<FileDependency[]> {
  if (paths.length > 5) throw new Error("At most five dependency files");
  const result: FileDependency[] = [];
  for (const path of paths) {
    signal.throwIfAborted();
    const { target } = await readTarget(workspace, path);
    const file = await open(target, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Dependency must be a file no larger than 1 MiB");
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        signal.throwIfAborted();
        const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > 1024 * 1024) throw new Error("Dependency grew beyond limit");
      signal.throwIfAborted();
      result.push({ path, sha256: createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex") });
    } finally { await file.close(); }
  }
  return result;
}
export async function checkDependencies(workspace: string | undefined, encoded: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  try {
    const dependencies: unknown = JSON.parse(encoded);
    if (!Array.isArray(dependencies) || dependencies.length > 5 || dependencies.some(item =>
      !item || typeof item.path !== "string" || !item.path || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256))) return false;
    if (!dependencies.length) return true;
    if (!workspace) return false;
    const current = await captureDependencies(workspace, dependencies.map(item => item.path), signal);
    return current.every((item, index) => item.sha256 === dependencies[index]!.sha256);
  } catch { signal.throwIfAborted(); return false; }
}
