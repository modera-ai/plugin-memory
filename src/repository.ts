import Database from "better-sqlite3";
import { duplicateKey } from "./duplicate-key";
import { createHash, randomUUID } from "node:crypto";
import { validateExperience, type MemoryExperience } from "./experience";
import { skillDraftContent } from "./skill-draft";
import { normalizedVector } from "./embeddings";
import { experienceToolDependencies } from "./tool-dependencies";

/** Stable source identity excludes mutable extraction-job metadata. */
function sourceKey(source: string): string {
  let identity = source;
  try {
    const parsed = JSON.parse(source) as { sessionId?: unknown; messageId?: unknown; importDigest?: unknown; importRecordId?: unknown };
    if (typeof parsed?.sessionId === "string" && typeof parsed.messageId === "string")
      identity = JSON.stringify([parsed.sessionId, parsed.messageId]);
    else if (typeof parsed?.importDigest === "string" && typeof parsed.importRecordId === "string")
      identity = JSON.stringify(["import", parsed.importDigest, parsed.importRecordId]);
  } catch { /* Legacy opaque sources retain exact-match semantics. */ }
  return "memory-source:v1:" + createHash("sha256").update(identity).digest("hex");
}

export interface MemoryRecord {
  dependencies: string;
  id: string;
  scope: string;
  text: string;
  revision: number;
  status: "active" | "candidate" | "stale" | "superseded";
  source: string;
  updatedAt: string;
}

function sourceKeys(source: string): string[] {
  const keys = [sourceKey(source)];
  try {
    const parsed = JSON.parse(source) as { sessionId?: string; experience?: MemoryExperience };
    if (typeof parsed?.sessionId === "string") {
      for (const step of [parsed.experience?.failure, parsed.experience?.fix, parsed.experience?.verification]) {
        if (typeof step?.sourceId === "string") keys.push(sourceKey(JSON.stringify({ sessionId: parsed.sessionId, messageId: step.sourceId })));
      }
    }
  } catch { /* Opaque legacy source. */ }
  return [...new Set(keys)];
}

/** Latin identifiers plus Han bigrams; index is disposable, source text is not. */
export function searchTerms(text: string): string[] {
  const terms: string[] = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  for (const run of text.match(/[\p{Script=Han}]+/gu) ?? []) {
    const chars = [...run];
    if (chars.length === 1) terms.push(chars[0]!);
    for (let i = 0; i < chars.length - 1; i++) terms.push(chars[i]! + chars[i + 1]!);
  }
  return [...new Set(terms)].slice(0, 256);
}

export class MemoryRepository {
  runCancellable<T>(operation: () => T, cancellation: Int32Array): T {
    return this.db.transaction(() => {
      if (Atomics.load(cancellation, 0)) throw new Error("Memory operation cancelled");
      const result = operation();
      if (Atomics.load(cancellation, 0)) throw new Error("Memory operation cancelled");
      return result;
    })();
  }
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 11) {
      this.db.close();
      throw new Error("Memory database requires a newer plugin version");
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("secure_delete = ON");
    this.db.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, text TEXT NOT NULL,
        revision INTEGER NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_scope ON memories(scope, status);
      CREATE TABLE IF NOT EXISTS memory_skill_drafts (
        id TEXT PRIMARY KEY, memoryId TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        scope TEXT NOT NULL, memoryRevision INTEGER NOT NULL, content TEXT NOT NULL,
        createdAt TEXT NOT NULL, UNIQUE(memoryId,scope,memoryRevision)
      );
      CREATE TABLE IF NOT EXISTS memory_revisions (
        memoryId TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, record TEXT NOT NULL,
        PRIMARY KEY(memoryId, revision)
      );
      CREATE TABLE IF NOT EXISTS memory_suppressions (
        scope TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(scope, source)
      );
      CREATE TABLE IF NOT EXISTS memory_session_suppressions (
        scope TEXT NOT NULL, sessionHash TEXT NOT NULL, PRIMARY KEY(scope, sessionHash)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, terms);
      CREATE TABLE IF NOT EXISTS memory_evidence_terms (
        memoryId TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        terms TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_vectors (
        memoryId TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        modelKey TEXT NOT NULL, revision INTEGER NOT NULL, dimensions INTEGER NOT NULL,
        vector TEXT NOT NULL, PRIMARY KEY(memoryId,modelKey)
      );
      CREATE TABLE IF NOT EXISTS memory_jobs (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, sessionId TEXT NOT NULL,
        cursor TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, availableAt INTEGER NOT NULL DEFAULT 0,
        leaseUntil INTEGER NOT NULL DEFAULT 0, leaseToken TEXT,
        UNIQUE(scope,sessionId,cursor)
      );
      CREATE TABLE IF NOT EXISTS memory_job_results (
        jobId TEXT PRIMARY KEY REFERENCES memory_jobs(id),
        detail TEXT NOT NULL DEFAULT '', inputTokens INTEGER, outputTokens INTEGER,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_job_evidence (
        jobId TEXT PRIMARY KEY REFERENCES memory_jobs(id), evidence TEXT NOT NULL
      );
    `))();
    if (version < 5) this.db.transaction(() => {
      this.db.exec("ALTER TABLE memories ADD COLUMN dependencies TEXT NOT NULL DEFAULT '[]'");
      this.db.pragma("user_version = 5");
    })();
    this.db.transaction(() => {
      const legacy = this.db.prepare("SELECT scope,source FROM memory_suppressions WHERE source NOT LIKE 'memory-source:v1:%'").all() as { scope: string; source: string }[];
      for (const row of legacy) {
        this.suppressSource(row.scope, row.source);
        this.db.prepare("DELETE FROM memory_suppressions WHERE scope=? AND source=?").run(row.scope, row.source);
      }
      const superseded = this.db.prepare("SELECT scope,source FROM memories WHERE status='superseded'").all() as { scope: string; source: string }[];
      for (const row of superseded) this.suppressSource(row.scope, row.source);
      this.db.pragma("user_version = 11");
    })();
  }

  jobResult(id: string, detail: string, usage?: { inputTokens: number; outputTokens: number }): void {
    this.db.prepare(`INSERT INTO memory_job_results VALUES(?,?,?,?,?) ON CONFLICT(jobId) DO UPDATE SET
      detail=excluded.detail, inputTokens=CASE WHEN excluded.inputTokens IS NULL THEN memory_job_results.inputTokens ELSE COALESCE(memory_job_results.inputTokens,0)+excluded.inputTokens END,
      outputTokens=CASE WHEN excluded.outputTokens IS NULL THEN memory_job_results.outputTokens ELSE COALESCE(memory_job_results.outputTokens,0)+excluded.outputTokens END,updatedAt=excluded.updatedAt`)
      .run(id, detail.slice(0, 300), usage?.inputTokens ?? null, usage?.outputTokens ?? null, Date.now());
  }

  jobStatus(scopes: readonly string[]): { state: string; attempts: number; detail: string | null; inputTokens: number | null; outputTokens: number | null }[] {
    if (!scopes.length) return [];
    return this.db.prepare(`SELECT j.state,j.attempts,r.detail,r.inputTokens,r.outputTokens FROM memory_jobs j
      LEFT JOIN memory_job_results r ON j.id=r.jobId WHERE j.scope IN (${scopes.map(() => "?").join(",")})
      ORDER BY r.updatedAt DESC LIMIT 10`).all(...scopes) as ReturnType<MemoryRepository["jobStatus"]>;
  }

  enqueue(scope: string, sessionId: string, cursor: string): void {
    if (!scope || !sessionId || !cursor) throw new Error("Job provenance required");
    this.db.prepare("INSERT OR IGNORE INTO memory_jobs(id,scope,sessionId,cursor) VALUES(?,?,?,?)").run(randomUUID(), scope, sessionId, cursor);
    if (this.sessionSuppressed(scope, sessionId)) this.cancelSessionJobs(scope, sessionId);
  }

  enqueueEvidence(scope: string, sessionId: string, cursor: string, evidence: string): void {
    if (evidence.length > 14000) throw new Error("Evidence budget exceeded");
    this.db.transaction(() => {
      this.enqueue(scope, sessionId, cursor);
      const job = this.db.prepare("SELECT id,state FROM memory_jobs WHERE scope=? AND sessionId=? AND cursor=?").get(scope, sessionId, cursor) as { id: string; state: string };
      if (job.state === "pending") this.db.prepare("INSERT OR IGNORE INTO memory_job_evidence VALUES(?,?)").run(job.id, evidence);
    })();
  }

  jobEvidence(id: string, leaseToken: string, now = Date.now()): string {
    const row = this.db.prepare(`SELECT e.evidence FROM memory_job_evidence e JOIN memory_jobs j ON j.id=e.jobId
      WHERE j.id=? AND j.leaseToken=? AND j.state='running' AND j.leaseUntil>?`).get(id, leaseToken, now) as { evidence: string } | undefined;
    if (!row) throw new Error("Job evidence missing or lease revoked");
    return row.evidence;
  }

  jobSettled(scope: string, sessionId: string, cursor: string, now = Date.now()): boolean {
    this.expireExhaustedJobs([scope], now);
    const job = this.db.prepare("SELECT state FROM memory_jobs WHERE scope=? AND sessionId=? AND cursor=?").get(scope, sessionId, cursor) as { state: string } | undefined;
    return !!job && ["done", "cancelled", "failed"].includes(job.state);
  }

  private expireExhaustedJobs(scopes: readonly string[], now: number): void {
    if (!scopes.length) return;
    this.db.transaction(() => {
      const exhausted = this.db.prepare(`SELECT id FROM memory_jobs WHERE scope IN (${scopes.map(() => "?").join(",")})
        AND attempts>=5 AND (state='pending' OR (state='running' AND leaseUntil<=?))`).all(...scopes, now) as { id: string }[];
      for (const { id } of exhausted) {
        this.db.prepare("UPDATE memory_jobs SET state='failed',leaseToken=NULL,leaseUntil=0 WHERE id=?").run(id);
        this.db.prepare("DELETE FROM memory_job_evidence WHERE jobId=?").run(id);
        this.jobResult(id, "自动学习重试已耗尽，未完成提取");
      }
    })();
  }

  claim(scopes: readonly string[], now = Date.now(), source?: { sessionId: string; cursor: string }): { id: string; scope: string; sessionId: string; cursor: string; leaseToken: string } | undefined {
    if (!scopes.length) return undefined;
    return this.db.transaction(() => {
      this.expireExhaustedJobs(scopes, now);
      const job = this.db.prepare(`SELECT * FROM memory_jobs WHERE scope IN (${scopes.map(() => "?").join(",")})
        AND attempts < 5 AND availableAt <= ? AND (state='pending' OR (state='running' AND leaseUntil <= ?))
        ${source ? "AND sessionId=? AND cursor=?" : ""}
        ORDER BY availableAt,id LIMIT 1`).get(...scopes, now, now, ...(source ? [source.sessionId, source.cursor] : [])) as { id: string; scope: string; sessionId: string; cursor: string } | undefined;
      if (!job) return undefined;
      const leaseToken = randomUUID();
      this.db.prepare("UPDATE memory_jobs SET state='running', attempts=attempts+1, leaseUntil=?,leaseToken=? WHERE id=?").run(now + 120_000, leaseToken, job.id);
      return { id: job.id, scope: job.scope, sessionId: job.sessionId, cursor: job.cursor, leaseToken };
    })();
  }

  finishJob(id: string, leaseToken: string, succeeded: boolean, now = Date.now()): void {
    this.db.transaction(() => {
    const result = this.db.prepare(`UPDATE memory_jobs SET state=CASE WHEN ? THEN 'done' WHEN attempts>=5 THEN 'failed' ELSE 'pending' END, availableAt=?, leaseUntil=0, leaseToken=NULL
      WHERE id=? AND state='running' AND leaseToken=? AND leaseUntil>?`)
      .run(succeeded ? 1 : 0, succeeded ? now : now + 60_000, id, leaseToken, now);
    if (!result.changes) throw new Error("Job lease expired or revoked");
    this.db.prepare("DELETE FROM memory_job_evidence WHERE jobId=? AND EXISTS (SELECT 1 FROM memory_jobs WHERE id=? AND state IN ('done','failed'))").run(id, id);
    })();
  }

  cancelSessionJobs(scope: string, sessionId: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM memory_job_evidence WHERE jobId IN (SELECT id FROM memory_jobs WHERE scope=? AND sessionId=?)").run(scope, sessionId);
      this.db.prepare("UPDATE memory_jobs SET state='cancelled',leaseToken=NULL,leaseUntil=0 WHERE scope=? AND sessionId=?").run(scope, sessionId);
    })();
  }

  cancelRunJob(scope: string, sessionId: string, cursor: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM memory_job_evidence WHERE jobId IN (SELECT id FROM memory_jobs WHERE scope=? AND sessionId=? AND cursor=?)").run(scope, sessionId, cursor);
      this.db.prepare("UPDATE memory_jobs SET state='cancelled',leaseToken=NULL,leaseUntil=0 WHERE scope=? AND sessionId=? AND cursor=?").run(scope, sessionId, cursor);
    })();
  }

  commitJob(id: string, leaseToken: string, candidates: readonly { text: string; sourceId: string; scope?: "global" | "project"; replaces?: { id: string; revision: number }; experience?: MemoryExperience }[], now = Date.now(), requireReview = true, duplicates: readonly { keep: { id: string; revision: number }; remove: { id: string; revision: number } }[] = []): number {
    if (candidates.length > 10) throw new Error("Too many memory candidates");
    return this.db.transaction(() => {
      const job = this.db.prepare("SELECT * FROM memory_jobs WHERE id=? AND state='running' AND leaseToken=? AND leaseUntil>?")
        .get(id, leaseToken, now) as { scope: string; sessionId: string; cursor: string } | undefined;
      if (!job) throw new Error("Job lease expired or revoked");
      if (duplicates.length > 5) throw new Error("Too many duplicate pairs");
      for (const pair of duplicates) this.mergeDuplicate([job.scope, "global"], pair.keep, pair.remove);
      let retained = 0;
      if (candidates.length) {
        const snapshot = JSON.parse(this.jobEvidence(id, leaseToken, now)) as { truncated?: boolean; evidence: { id: string; role: string; text?: string; truncated?: boolean; toolProvenance?: import("@modera/contracts").ChatMessage["toolProvenance"] }[] };
        for (const candidate of candidates) {
          if (candidate.scope !== undefined && candidate.scope !== "global" && candidate.scope !== "project") throw new Error("Invalid extraction scope");
          const targetScope = candidate.scope === "global" ? "global" : job.scope;
          if (candidate.scope === "global" && (candidate.experience || !snapshot.evidence.some(message => message.id === candidate.sourceId && message.role === "user"))) throw new Error("Global preferences require user evidence");
          if (!snapshot.evidence.some(message => message.id === candidate.sourceId)) throw new Error("Unknown extraction source");
          if (candidate.experience) {
            validateExperience(candidate.experience, snapshot.evidence);
            if (candidate.sourceId !== candidate.experience.verification.sourceId) throw new Error("Experience primary source must be its verification");
          }
          if (candidate.replaces) {
            const target = this.get(targetScope, candidate.replaces.id);
            if (!target || target.status !== "active" || target.revision !== candidate.replaces.revision) throw new Error("Replacement target missing or revision conflict");
          }
          const toolDependencies = experienceToolDependencies(candidate.experience, snapshot.evidence);
          const source = JSON.stringify({ sessionId: job.sessionId, runId: job.cursor, cursor: job.cursor, jobId: id, messageId: candidate.sourceId, ...(candidate.replaces ? { replaces: candidate.replaces } : {}), ...(candidate.experience ? { experience: candidate.experience } : {}), ...(toolDependencies.length ? { toolDependencies } : {}) });
          if (this.sourceSuppressed(job.scope, source) || this.sourceSuppressed(targetScope, source)) continue;
          const evidence = snapshot.evidence.find(message => message.id === candidate.sourceId)!;
          if (!candidate.replaces && this.db.prepare("SELECT 1 FROM memories WHERE scope=? AND text=? AND status IN ('active','candidate')").get(targetScope, candidate.text.trim())) continue;
          const automatic = !requireReview && !snapshot.truncated && !candidate.replaces && !evidence.truncated && (evidence.role === "user" || !!candidate.experience);
          const memory = this.save({ scope: targetScope, text: candidate.text, status: automatic ? "active" : "candidate", source });
          // Use only this claim's referenced evidence, never unrelated messages in the run.
          const terms = searchTerms(evidence.text ?? "").join(" ");
          this.db.prepare("INSERT OR IGNORE INTO memory_evidence_terms VALUES (?,?)").run(memory.id, terms);
          this.indexMemory(memory);
          retained++;
        }
      }
      this.finishJob(id, leaseToken, true, now);
      this.db.prepare("DELETE FROM memory_job_evidence WHERE jobId=?").run(id);
      return retained;
    })();
  }

  get(scope: string, id: string): MemoryRecord | undefined {
    return this.db.prepare("SELECT * FROM memories WHERE scope=? AND id=?").get(scope, id) as MemoryRecord | undefined;
  }

  mergeDuplicate(scopes: readonly string[], keepRef: { id: string; revision: number }, removeRef: { id: string; revision: number }): boolean {
    return this.db.transaction(() => {
      if (keepRef.id === removeRef.id) return false;
      const keep = scopes.map(scope => this.get(scope, keepRef.id)).find(Boolean);
      const remove = scopes.map(scope => this.get(scope, removeRef.id)).find(Boolean);
      if (!keep || !remove || keep.scope !== remove.scope || keep.revision !== keepRef.revision || remove.revision !== removeRef.revision) return false;
      if (!["active", "candidate"].includes(keep.status) || !["active", "candidate"].includes(remove.status)) return false;
      // Do not downgrade an accepted fact or merge dependency-bound procedures.
      if (keep.status === "candidate" && remove.status === "active") return false;
      if (keep.dependencies !== "[]" || remove.dependencies !== "[]") return false;
      const numbers = (text: string) => (text.match(/\d+(?:\.\d+)?/g) ?? []).sort().join("|");
      const negated = (text: string) => /不|不要|禁止|从不|不能|无需|\b(?:not|never|no|without|dislikes?|avoid)\b/i.test(text);
      if (numbers(keep.text) !== numbers(remove.text) || negated(keep.text) !== negated(remove.text)) return false;
      for (const item of [keep, remove]) {
        try { const source = JSON.parse(item.source); if (source.experience || source.replaces) return false; } catch { /* legacy */ }
      }
      let source: object;
      try { source = JSON.parse(remove.source); } catch { source = { legacySource: remove.source }; }
      this.save({ ...remove, expectedRevision: remove.revision, status: "superseded", source: JSON.stringify({ ...source, mergedInto: keep.id }) });
      this.suppressSource(remove.scope, remove.source);
      return true;
    })();
  }

  consolidate(scopes: readonly string[]): number {
    if (!scopes.length) return 0;
    return this.db.transaction(() => {
      const records = this.db.prepare(`SELECT * FROM memories WHERE scope IN (${scopes.map(() => "?").join(",")}) AND status IN ('active','candidate') ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updatedAt DESC LIMIT 5000`).all(...scopes) as MemoryRecord[];
      const seen = new Map<string, MemoryRecord>();
      let merged = 0;
      for (const record of records) {
        const key = JSON.stringify([record.scope, duplicateKey(record.text)]);
        const previous = seen.get(key);
        if (previous) { if (this.mergeDuplicate(scopes, previous, record)) merged++; }
        else seen.set(key, record);
      }
      return merged;
    })();
  }

  pendingVectors(scopes: readonly string[], modelKey: string): MemoryRecord[] {
    if (!scopes.length) return [];
    return this.db.prepare(`SELECT m.* FROM memories m LEFT JOIN memory_vectors v ON v.memoryId=m.id AND v.modelKey=? AND v.revision=m.revision
      WHERE m.scope IN (${scopes.map(() => "?").join(",")}) AND m.status='active' AND v.memoryId IS NULL ORDER BY m.updatedAt DESC LIMIT 16`).all(modelKey, ...scopes) as MemoryRecord[];
  }

  clearVectors(scopes: readonly string[]): number {
    if (!scopes.length) return 0;
    return this.db.prepare(`DELETE FROM memory_vectors WHERE memoryId IN (SELECT id FROM memories WHERE scope IN (${scopes.map(() => "?").join(",")}))`).run(...scopes).changes;
  }

  putVectors(scopes: readonly string[], modelKey: string, entries: readonly { id: string; revision: number; vector: number[] }[]): number {
    if (!/^[a-f0-9]{64}$/.test(modelKey) || entries.length > 16) throw new Error("Invalid vector batch");
    return this.db.transaction(() => {
      let stored = 0;
      for (const entry of entries) {
        const record = this.db.prepare("SELECT * FROM memories WHERE id=?").get(entry.id) as MemoryRecord | undefined;
        if (!record || !scopes.includes(record.scope) || record.status !== "active" || record.revision !== entry.revision) continue;
        const vector = normalizedVector(entry.vector);
        this.db.prepare("INSERT INTO memory_vectors VALUES (?,?,?,?,?) ON CONFLICT(memoryId,modelKey) DO UPDATE SET revision=excluded.revision,dimensions=excluded.dimensions,vector=excluded.vector").run(entry.id, modelKey, entry.revision, vector.length, JSON.stringify(vector));
        this.db.prepare("DELETE FROM memory_vectors WHERE memoryId=? AND modelKey NOT IN (SELECT modelKey FROM memory_vectors WHERE memoryId=? ORDER BY (modelKey=?) DESC,rowid DESC LIMIT 4)").run(entry.id, entry.id, modelKey);
        stored++;
      }
      return stored;
    })();
  }

  searchVectors(scopes: readonly string[], modelKey: string, query: number[]): MemoryRecord[] {
    if (!scopes.length) return [];
    const vector = normalizedVector(query);
    const rows = this.db.prepare(`SELECT m.*,v.vector FROM memory_vectors v JOIN memories m ON m.id=v.memoryId
      WHERE m.scope IN (${scopes.map(() => "?").join(",")}) AND m.status='active' AND v.modelKey=? AND v.revision=m.revision AND v.dimensions=? ORDER BY m.updatedAt DESC LIMIT 5000`).all(...scopes, modelKey, vector.length) as (MemoryRecord & { vector: string })[];
    return rows.flatMap(({ vector: encoded, ...record }) => {
      try {
        const values = normalizedVector(JSON.parse(encoded));
        if (values.length !== vector.length) return [];
        const score = values.reduce((sum, value, index) => sum + value * vector[index]!, 0);
        return score >= 0.3 ? [{ record, score }] : [];
      } catch { return []; }
    }).sort((a, b) => b.score - a.score).slice(0, 12).map(item => item.record);
  }

  history(scope: string, id: string, offset = 0): MemoryRecord[] {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid history offset");
    if (!this.get(scope, id)) return [];
    return (this.db.prepare(`SELECT r.record FROM memory_revisions r
      WHERE r.memoryId=? AND json_extract(r.record,'$.scope')=?
      ORDER BY r.revision DESC LIMIT 20 OFFSET ?`).all(id, scope, offset) as { record: string }[])
      .map(row => JSON.parse(row.record) as MemoryRecord);
  }

  createSkillDraft(scope: string, id: string, expectedRevision: number): { id: string; content: string; memoryRevision: number } {
    return this.db.transaction(() => {
      const record = this.get(scope, id);
      if (!record || record.revision !== expectedRevision) throw new Error("Memory missing or revision conflict");
      const content = skillDraftContent(record);
      this.db.prepare("INSERT INTO memory_skill_drafts VALUES (?,?,?,?,?,?) ON CONFLICT(memoryId,scope,memoryRevision) DO UPDATE SET content=excluded.content").run(randomUUID(), id, scope, record.revision, content, new Date().toISOString());
      return this.db.prepare("SELECT id,content,memoryRevision FROM memory_skill_drafts WHERE memoryId=? AND scope=? AND memoryRevision=?").get(id, scope, record.revision) as { id: string; content: string; memoryRevision: number };
    })();
  }

  readSkillDraft(scope: string, id: string): { id: string; memoryId: string; content: string; memoryRevision: number; stale: boolean } | undefined {
    const row = this.db.prepare(`SELECT d.id,d.memoryId,d.content,d.memoryRevision,m.revision,m.status FROM memory_skill_drafts d
      JOIN memories m ON m.id=d.memoryId WHERE d.id=? AND d.scope=? AND m.scope=?`).get(id, scope, scope) as { id: string; memoryId: string; content: string; memoryRevision: number; revision: number; status: string } | undefined;
    if (!row) return undefined;
    const stale = row.revision !== row.memoryRevision || row.status !== "active";
    // Active drafts are derived artifacts: render with the current template so old
    // cached drafts cannot export instructions without the host source guard.
    const content = stale ? row.content : skillDraftContent(this.get(scope, row.memoryId)!);
    return { id: row.id, memoryId: row.memoryId, content, memoryRevision: row.memoryRevision, stale };
  }

  confirm(scope: string, id: string, expectedRevision: number): MemoryRecord {
    return this.db.transaction(() => {
      const candidate = this.get(scope, id);
      if (!candidate || candidate.revision !== expectedRevision || candidate.status !== "candidate") throw new Error("Candidate missing or revision conflict");
      const source = JSON.parse(candidate.source) as { replaces?: { id: string; revision: number } };
      if (source.replaces) {
        const target = this.get(scope, source.replaces.id);
        if (!target || target.status !== "active" || target.revision !== source.replaces.revision) throw new Error("Replacement target changed; review the correction again");
        this.save({ ...target, expectedRevision: target.revision, status: "superseded" });
        this.suppressSource(scope, target.source);
      }
      return this.save({ ...candidate, expectedRevision, status: "active" });
    })();
  }

  move(scope: string, id: string, expectedRevision: number, target: string): MemoryRecord {
    return this.db.transaction(() => {
      const record = this.get(scope, id);
      if (!record || record.revision !== expectedRevision) throw new Error("Memory missing or revision conflict");
      if (scope !== target && record.status === "candidate") {
        let replacement: unknown;
        try { replacement = JSON.parse(record.source)?.replaces; } catch { /* legacy source */ }
        if (replacement) throw new Error("Review correction in its original scope before moving");
      }
      if (scope !== target && record.dependencies !== "[]") throw new Error("File-dependent memory cannot move scopes; clear or revalidate dependencies first");
      const moved = { ...record, scope: target, revision: record.revision + 1, updatedAt: new Date().toISOString() };
      this.db.prepare("UPDATE memories SET scope=@scope,revision=@revision,updatedAt=@updatedAt WHERE id=@id").run(moved);
      this.db.prepare("INSERT INTO memory_revisions VALUES (?,?,?)").run(id, moved.revision, JSON.stringify(moved));
      return moved;
    })();
  }

  list(scopes: readonly string[], query = "", includeCandidates = false, offset = 0): MemoryRecord[] {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid page offset");
    if (!scopes.length) return [];
    const terms = searchTerms(query).slice(0, 24);
    const placeholders = scopes.map(() => "?").join(",");
    const filter = includeCandidates ? "" : " AND status = 'active'";
    if (terms.length) {
      return this.db.prepare(`SELECT m.* FROM memory_fts f JOIN memories m ON m.id=f.id
        WHERE memory_fts MATCH ? AND m.scope IN (${placeholders})${filter}
        ORDER BY bm25(memory_fts), m.updatedAt DESC LIMIT 100 OFFSET ?`)
        .all(terms.map(term => `"${term}"`).join(" OR "), ...scopes, offset) as MemoryRecord[];
    }
    if (query.trim()) return [];
    return this.db.prepare(`SELECT * FROM memories WHERE scope IN (${placeholders})${filter} ORDER BY updatedAt DESC LIMIT 100 OFFSET ?`)
      .all(...scopes, offset) as MemoryRecord[];
  }

  private sourceSuppressed(scope: string, source: string): boolean {
    try {
      const parsed = JSON.parse(source) as { sessionId?: unknown };
      if (typeof parsed?.sessionId === "string" && this.sessionSuppressed(scope, parsed.sessionId)) return true;
    } catch { /* Opaque legacy source. */ }
    return sourceKeys(source).some(key => !!this.db.prepare("SELECT 1 FROM memory_suppressions WHERE scope=? AND source=?").get(scope, key));
  }

  private sessionSuppressed(scope: string, sessionId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM memory_session_suppressions WHERE scope=? AND sessionHash=?")
      .get(scope, createHash("sha256").update(sessionId).digest("hex"));
  }

  /** Caller supplies authorized scopes; matching includes every historical source revision. */
  forgetSession(scopes: readonly string[], sessionId: string): number {
    if (!sessionId || !scopes.length || scopes.some(scope => !scope)) throw new Error("Missing forget scope or session");
    return this.db.transaction(() => {
      let removed = 0;
      for (const scope of new Set(scopes)) {
        this.db.prepare("INSERT OR IGNORE INTO memory_session_suppressions VALUES (?,?)")
          .run(scope, createHash("sha256").update(sessionId).digest("hex"));
        this.cancelSessionJobs(scope, sessionId);
        const records = this.db.prepare("SELECT * FROM memories WHERE scope=?").all(scope) as MemoryRecord[];
        for (const record of records) {
          const revisions = this.db.prepare("SELECT record FROM memory_revisions WHERE memoryId=?").all(record.id) as { record: string }[];
          const matches = [record.source, ...revisions.map(row => (JSON.parse(row.record) as MemoryRecord).source)].some(source => {
            try { return (JSON.parse(source) as { sessionId?: unknown })?.sessionId === sessionId; }
            catch { return false; }
          });
          if (matches) { this.forget(scope, record.id, record.revision); removed++; }
        }
      }
      return removed;
    })();
  }

  private suppressSource(scope: string, source: string): void {
    for (const key of sourceKeys(source)) this.db.prepare("INSERT OR IGNORE INTO memory_suppressions VALUES (?,?)").run(scope, key);
  }

  importCandidates(scope: string, entries: readonly { text: string; source: string }[]): number {
    if (entries.length > 100) throw new Error("Too many imported records");
    return this.db.transaction(() => {
      let added = 0;
      for (const entry of entries) {
        if (this.sourceSuppressed(scope, entry.source)) continue;
        if (this.db.prepare("SELECT 1 FROM memories WHERE scope=? AND text=? AND status IN ('active','candidate')").get(scope, entry.text.trim())) continue;
        this.save({ scope, ...entry, status: "candidate" });
        added++;
      }
      return added;
    })();
  }

  save(input: { scope: string; text: string; source: string; status: MemoryRecord["status"]; id?: string; expectedRevision?: number; dependencies?: string }): MemoryRecord {
    if (!input.scope || !input.source || !input.text.trim() || input.text.length > 4000)
      throw new Error("Invalid memory content or scope");
    return this.db.transaction(() => {
      if (this.sourceSuppressed(input.scope, input.source))
        throw new Error("Source was forgotten; automatic re-extraction is suppressed");
      const previous = input.id ? this.db.prepare("SELECT * FROM memories WHERE scope=? AND id=?").get(input.scope, input.id) as MemoryRecord | undefined : undefined;
      if (input.id && (!previous || previous.revision !== input.expectedRevision))
        throw new Error("Memory missing or revision conflict");
      if (!input.id) {
        const duplicate = this.db.prepare("SELECT * FROM memories WHERE scope=? AND text=? AND status=?").get(input.scope, input.text.trim(), input.status) as MemoryRecord | undefined;
        if (duplicate) return duplicate;
      }
      const record: MemoryRecord = { dependencies: input.dependencies ?? previous?.dependencies ?? "[]", id: previous?.id ?? randomUUID(), scope: input.scope, text: input.text.trim(), revision: (previous?.revision ?? 0) + 1, status: input.status, source: input.source, updatedAt: new Date().toISOString() };
      this.db.prepare(`INSERT INTO memories(id,scope,text,revision,status,source,updatedAt,dependencies) VALUES (@id,@scope,@text,@revision,@status,@source,@updatedAt,@dependencies)
        ON CONFLICT(id) DO UPDATE SET text=excluded.text, revision=excluded.revision,
        status=excluded.status, source=excluded.source, updatedAt=excluded.updatedAt,dependencies=excluded.dependencies`).run(record);
      this.db.prepare("INSERT INTO memory_revisions VALUES (?,?,?)").run(record.id, record.revision, JSON.stringify(record));
      this.db.prepare("DELETE FROM memory_vectors WHERE memoryId=?").run(record.id);
      if (previous && (previous.source !== record.source || previous.text !== record.text))
        this.db.prepare("DELETE FROM memory_evidence_terms WHERE memoryId=?").run(record.id);
      this.indexMemory(record);
      return record;
    })();
  }

  private indexMemory(record: MemoryRecord): void {
    const evidence = this.db.prepare("SELECT terms FROM memory_evidence_terms WHERE memoryId=?").get(record.id) as { terms: string } | undefined;
    const terms = [...new Set([...searchTerms(record.text), ...(evidence?.terms.split(" ").filter(Boolean) ?? [])])].join(" ");
    this.db.prepare("DELETE FROM memory_fts WHERE id=?").run(record.id);
    this.db.prepare("INSERT INTO memory_fts (id,terms) VALUES (?,?)").run(record.id, terms);
  }

  forget(scope: string, id: string, expectedRevision: number): void {
    this.db.transaction(() => {
      const record = this.db.prepare("SELECT * FROM memories WHERE scope=? AND id=?").get(scope, id) as MemoryRecord | undefined;
      if (!record || record.revision !== expectedRevision) throw new Error("Memory missing or revision conflict");
      const sources = this.db.prepare("SELECT record FROM memory_revisions WHERE memoryId=?").all(id) as { record: string }[];
      for (const row of sources) {
        const revision = JSON.parse(row.record) as MemoryRecord;
        this.suppressSource(revision.scope, revision.source);
        this.suppressSource(scope, revision.source);
      }
      this.db.prepare("DELETE FROM memory_fts WHERE id=?").run(id);
      this.db.prepare("DELETE FROM memories WHERE scope=? AND id=?").run(scope, id);
    })();
  }

  close(): void { this.db.close(); }
}
