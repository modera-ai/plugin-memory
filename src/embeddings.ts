import { createHash } from "node:crypto";

export interface EmbeddingIdentity { key: string; model: string; digest: string }
export interface EmbeddingProvider {
  identify(signal: AbortSignal): Promise<EmbeddingIdentity>;
  embed(texts: readonly string[], identity: EmbeddingIdentity, signal: AbortSignal): Promise<number[][]>;
}
export function normalizedVector(raw: unknown): number[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 4096 || raw.some(value => typeof value !== "number" || !Number.isFinite(value))) throw new Error("Invalid embedding vector");
  const norm = Math.hypot(...raw);
  if (!Number.isFinite(norm) || norm === 0) throw new Error("Invalid embedding norm");
  return raw.map(value => value / norm);
}

/** Optional local provider; never downloads models or sends memory to a remote host. */
export class OllamaEmbeddings implements EmbeddingProvider {
  private readonly base: URL;
  constructor(endpoint: string, private readonly model: string) {
    this.base = new URL(endpoint);
    if (!["http:", "https:"].includes(this.base.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(this.base.hostname) || this.base.username || this.base.password || this.base.search || this.base.hash || this.base.pathname !== "/") throw new Error("Embeddings require a local Ollama origin without credentials");
    if (!model.trim() || model.length > 200) throw new Error("Embedding model required");
  }
  private async request(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.base), { signal, redirect: "error", ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Local embedding service unavailable"); }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 2_000_000) throw new Error("Embedding response exceeds budget");
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  async identify(signal: AbortSignal): Promise<EmbeddingIdentity> {
    const result = await this.request("/api/tags", signal) as { models?: { name: string; digest: string }[] };
    const canonical = (name: string) => name.includes(":") ? name : `${name}:latest`;
    const model = result.models?.find(item => typeof item.name === "string" && canonical(item.name) === canonical(this.model));
    if (!model || typeof model.digest !== "string" || !/^[a-f0-9]{64}$/i.test(model.digest)) throw new Error("Embedding model not installed or missing digest");
    return { model: model.name, digest: model.digest, key: createHash("sha256").update(JSON.stringify(["ollama-plain-v1", this.base.href, model.name, model.digest])).digest("hex") };
  }
  async embed(texts: readonly string[], identity: EmbeddingIdentity, signal: AbortSignal): Promise<number[][]> {
    if (!texts.length || texts.length > 16 || texts.some(text => text.length > 4000)) throw new Error("Embedding input exceeds budget");
    const result = await this.request("/api/embed", signal, { model: identity.model, input: texts, truncate: false }) as { embeddings?: unknown[] };
    if (!Array.isArray(result.embeddings) || result.embeddings.length !== texts.length) throw new Error("Embedding count mismatch");
    const vectors = result.embeddings.map(normalizedVector);
    if (vectors.some(vector => vector.length !== vectors[0]!.length)) throw new Error("Embedding dimensions mismatch");
    if ((await this.identify(signal)).key !== identity.key) throw new Error("Embedding model changed during request");
    return vectors;
  }
}
