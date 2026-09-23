import { build } from "esbuild";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
let ready: Promise<string> | undefined;
export function memoryResources(): Promise<string> {
  return ready ??= (async () => {
    const root = resolve("artifacts/memory-plugin-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "worker-"));
    // The plugin loads its worker from `dist/`, the same place it keeps the
    // entry, so a stand-in resource path has to mirror that layout.
    const dist = join(directory, "dist");
    await mkdir(dist, { recursive: true });
    await build({ entryPoints: [resolve("plugins/memory/src/database.worker.ts")], outfile: join(dist, "database.worker.cjs"), bundle: true, platform: "node", format: "cjs", packages: "external" });
    return directory;
  })();
}
