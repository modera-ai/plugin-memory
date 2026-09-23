import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureDependencies, checkDependencies } from "../src/dependencies";

it("detects changed and removed project files while rejecting out-of-workspace dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-dependency-"));
  const signal = new AbortController().signal;
  try {
    const file = join(directory, "package.json");
    await writeFile(file, '{"packageManager":"pnpm"}');
    const saved = JSON.stringify(await captureDependencies(directory, ["package.json"], signal));
    expect(await checkDependencies(directory, saved, signal)).toBe(true);
    await writeFile(file, '{"packageManager":"npm"}');
    expect(await checkDependencies(directory, saved, signal)).toBe(false);
    await rm(file);
    expect(await checkDependencies(directory, saved, signal)).toBe(false);
    await expect(captureDependencies(directory, ["../other/package.json"], signal)).rejects.toThrow("outside");
    expect(await checkDependencies(undefined, saved, signal)).toBe(false);
    for (const invalid of ["broken json", "null", "{}", '[{"path":"package.json","sha256":"invalid"}]']) {
      expect(await checkDependencies(directory, invalid, signal)).toBe(false);
    }
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(checkDependencies(directory, "[]", cancelled.signal)).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
