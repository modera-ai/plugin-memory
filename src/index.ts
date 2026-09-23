import manifest from "../plugin.json";
import { declaredTool } from "@modera/plugin-sdk";
import { composerDocument } from "../ui/composer-document";
import { activityDocument } from "../ui/activity-document";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { mkdir, mkdtemp, open, rm, rmdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { historyDefinition, historyTool } from "./history-tool";
import { rebuildVectors, semanticRecall, fuseRecall } from "./semantic-memory";
import { rememberIntent } from "./remember-intent";
import { toolDependenciesMatch } from "./tool-dependencies";
import type { PluginManifest, PluginModule, ToolContext, ToolContribution, PluginUiNode } from "@modera/plugin-sdk";
import { MemoryDatabaseClient } from "./database-client";
import { captureDependencies, checkDependencies } from "./dependencies";
import { extractionPrompt, parseExtractionResponse } from "./extraction-prompt";
import { exportMemoryPage } from "./export";
import { parseMemoryImport } from "./import";
import { validateExperience, experienceText, type MemoryExperience } from "./experience";

const permissions = ["storage.read", "storage.write", "workspace.read"] as const;
const databases = new Set<MemoryDatabaseClient>();
export async function deactivate(): Promise<void> {
  await Promise.all([...databases].map(async db => { try { await db.close(); } finally { databases.delete(db); } }));
}
const definition = declaredTool(manifest, "memory_manage");

function scopeKey(scope: string | undefined, context: Pick<ToolContext, "projectId">): string {
  if (scope === "global") return "global";
  if (!context.projectId) throw new Error("Project memory requires a selected project; select global scope explicitly");
  return `project:${context.projectId}`;
}
function content(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4000) throw new Error("Memory text required (1–4000 characters)");
  if (/(?:\b(?:sk|ghp|github_pat)[-_][a-zA-Z0-9_-]{16,}|-----BEGIN .*PRIVATE KEY-----|\bBearer\s+\S{16,})/i.test(value))
    throw new Error("Do not store credentials in memory");
  return value.trim();
}

function sourceLink(source: string): PluginUiNode[] {
  try {
    const parsed = JSON.parse(source) as { sessionId?: string; messageId?: string; experience?: MemoryExperience };
    if (typeof parsed.sessionId !== "string") return [];
    const links: PluginUiNode[] = [{ type: "conversation-link", label: "查看来源对话", sessionId: parsed.sessionId, ...(typeof parsed.messageId === "string" ? { messageId: parsed.messageId } : {}) }];
    for (const [step, label] of [[parsed.experience?.failure, "查看失败依据"], [parsed.experience?.fix, "查看修复依据"]] as const) {
      if (typeof step?.sourceId === "string") links.push({ type: "conversation-link", label, sessionId: parsed.sessionId, messageId: step.sourceId });
    }
    return links;
  } catch { return []; }
}

async function checkRecordDependencies(record: { source: string; dependencies: string }, context: Pick<ToolContext, "workspacePath" | "signal" | "toolVersions">): Promise<boolean> {
  return toolDependenciesMatch(record.source, context.toolVersions) && await checkDependencies(context.workspacePath, record.dependencies, context.signal);
}

export const activate: PluginModule["activate"] = async host => {
  await mkdir(host.storagePath, { recursive: true });
  if (!host.resourcePath) throw new Error("Memory backend resources unavailable");
  const db = new MemoryDatabaseClient(join(host.resourcePath, "dist", "database.worker.cjs"), join(host.storagePath, "memory.sqlite"));
  databases.add(db);
  await db.call("list", []);
  const pages = new Map<string, number>();
  let scheduled: readonly { projectId: string; queuedAt: number; checkAt?: number }[] = [];
  const manualRequests = new Set<string>();
  const learningActivity = new Map<string, { running: Set<string>; state: "idle" | "running" | "success" | "error"; updatedAt: number }>();
  const activityKey = (projectId: string | undefined, sessionId: string) => JSON.stringify([projectId, sessionId]);
  const activityChanged = (key: string, runId: string, state: "running" | "success" | "error") => {
    const entry = learningActivity.get(key) ?? { running: new Set<string>(), state: "idle" as const, updatedAt: 0 };
    if (state === "running") entry.running.add(runId); else entry.running.delete(runId);
    learningActivity.set(key, { running: entry.running, state: entry.running.size ? "running" : state, updatedAt: Date.now() });
    for (const [id, old] of learningActivity) if (!old.running.size && Date.now() - old.updatedAt > 60000) learningActivity.delete(id);
    host.invalidateUi?.();
  };
  const detailViews = new Map<string, string>();
  const historyViews = new Map<string, { scope: string; id: string; offset: number }>();
  const draftViews = new Map<string, { scope: string; id: string; exportPath?: string }>();
  const indexing = new Set<string>();
  const lastIndexAttempt = new Map<string, number>();
  host.signal.addEventListener("abort", () => { void db.close().catch(() => {}); }, { once: true });
  const assertActive = (context: { signal: AbortSignal }) => { host.signal.throwIfAborted(); context.signal.throwIfAborted(); };
  const execute: ToolContribution["execute"] = async (raw, context) => {
    const database = db.scoped(AbortSignal.any([host.signal, context.signal]));
    assertActive(context);
    const input = raw as { action: string; scope?: string; query?: string; text?: string; id?: string; revision?: number; offset?: number; files?: string[]; format?: "json" | "markdown"; document?: string };
    const scope = scopeKey(input.scope, context);
    if (input.action === "read_draft" || input.action === "export_skill") {
      if (!input.id) throw new Error("Draft ID required");
      const draft = await database.call("readSkillDraft", scope, input.id);
      if (!draft) {
        if (input.action === "export_skill") throw new Error("Draft source is unavailable");
        return { draft: null };
      }
      const record = await database.call("get", scope, draft.memoryId);
      const applicable = record && await checkRecordDependencies(record, context);
      if (input.action === "export_skill") {
        if (draft.stale || !applicable) throw new Error("Revalidate the experience and generate a current draft before exporting");
        const exports = join(host.storagePath, "exports");
        await mkdir(exports, { recursive: true });
        const directory = await mkdtemp(join(exports, "skill-"));
        const path = join(directory, "SKILL.md");
        try {
          assertActive(context);
          await writeFile(path, draft.content, { flag: "wx", encoding: "utf8", signal: AbortSignal.any([host.signal, context.signal]) });
          assertActive(context);
          return { path, memoryId: draft.memoryId, revision: draft.memoryRevision, note: "Use the existing skill installer to review and install this file. Export does not enable it. Exported copies are independent of future memory changes or deletion." };
        } catch (error) { await rm(path, { force: true }); await rmdir(directory); throw error; }
      }
      return { draft: { ...draft, stale: draft.stale || !applicable }, note: "Revalidate stale drafts before using or installing them." };
    }
    if (input.action === "draft_skill") {
      if (!input.id || !input.revision) throw new Error("Memory ID and revision required");
      const record = await database.call("get", scope, input.id);
      if (!record || !await checkRecordDependencies(record, context)) throw new Error("Memory dependencies need revalidation before drafting");
      const draft = await database.call("createSkillDraft", scope, input.id, input.revision);
      return { draft, note: "Draft only; not installed, enabled, or granted any execution permissions. Read it again before use to check source revision validity." };
    }
    if (input.action === "import") {
      if (!input.document || !context.toolCallId) throw new Error("Export document and host tool provenance required");
      const imported = parseMemoryImport(input.document);
      const entries = imported.records.map(record => ({ text: content(record.text), source: JSON.stringify({
        sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId,
        kind: "import", importDigest: record.importDigest, importRecordId: record.id,
        importedFrom: { scope: record.scope, revision: record.revision, sourceHash: record.sourceHash },
      }) }));
      const added = await database.call("importCandidates", scope, entries);
      host.invalidateUi?.();
      return { added, skipped: imported.skipped + entries.length - added, note: "Imported as candidates. Original status, correction links and file dependencies are not activated; review before recall. This does not restore revision history or conversations." };
    }
    if (input.action === "export") {
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid export offset");
      const format = input.format ?? "json";
      if (format !== "json" && format !== "markdown") throw new Error("Invalid export format");
      const records = await database.call("list", [scope], "", true, offset);
      assertActive(context);
      const directory = join(host.storagePath, "exports");
      await mkdir(directory, { recursive: true });
      const path = join(directory, `memory-${randomUUID()}.${format === "json" ? "json" : "md"}`);
      const file = await open(path, "wx");
      try {
        try { await file.writeFile(exportMemoryPage(scope, records, offset, format), { encoding: "utf8", signal: AbortSignal.any([host.signal, context.signal]) }); }
        finally { await file.close(); }
        assertActive(context);
      } catch (error) { await rm(path, { force: true }); throw error; }
      return { path, count: records.length, nextOffset: records.length === 100 ? offset + 100 : null, note: "Current records in this scope only. Exported copies are independent and are not removed when a memory is forgotten." };
    }
    if (input.action === "history") {
      if (!input.id) throw new Error("Memory ID required");
      return { revisions: await database.call("history", scope, input.id, input.offset ?? 0) };
    }
    if (input.action === "list" || input.action === "search") return { memories: await database.call("list", [scope], input.query ?? "", true, input.offset ?? 0) };
    if (input.action === "read") return { memory: input.id ? await database.call("get", scope, input.id) ?? null : null };
    if (input.action === "validate") {
      if (!input.id || !input.revision) throw new Error("Memory ID and expected revision required");
      const record = await database.call("get", scope, input.id);
      if (!record) return { usable: false, reason: "source_unavailable" };
      if (record.revision !== input.revision) return { usable: false, reason: "source_changed", revision: record.revision };
      if (record.status !== "active") return { usable: false, reason: "source_not_active" };
      if (!await checkRecordDependencies(record, context)) return { usable: false, reason: "dependencies_changed" };
      return { usable: true, revision: record.revision, scope: record.scope };
    }
    if (input.action === "forget") {
      if (!input.id || !input.revision) throw new Error("ID and revision required");
      await database.call("forget", scope, input.id, input.revision);
      return { forgotten: input.id, note: "Removed from long-term recall; original conversation text is unchanged." };
    }
    if (input.action !== "save" && input.action !== "update") throw new Error("Unknown memory action");
    if (input.action === "update" && (!input.id || !input.revision)) throw new Error("ID and revision required");
    if (!context.toolCallId) throw new Error("Host tool provenance required");
    const text = content(input.text);
    if (input.files?.length && (scope === "global" || !context.workspacePath)) throw new Error("File-dependent memories require a project workspace");
    const dependencies = input.files ? JSON.stringify(await captureDependencies(context.workspacePath ?? "", input.files, context.signal)) : undefined;
    assertActive(context);
    const intent = rememberIntent(context.userMessage?.text, text);
    if (intent === "denied") throw new Error("The current user explicitly declined memory storage");
    const explicitlyRequested = intent === "explicit";
    const record = await database.call("save", { scope, text, source: JSON.stringify({ sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId, ...(context.userMessage ? { messageId: context.userMessage.id } : {}) }), status: explicitlyRequested ? "active" : "candidate",
      ...(dependencies === undefined ? {} : { dependencies }), ...(input.action === "update" ? { id: input.id!, expectedRevision: input.revision! } : {}) });
    return { memory: record, note: explicitlyRequested ? "Saved from the current user's explicit request." : "Candidate saved; confirm in memory panel before automatic recall." };
  };
  return {
    observationSchedule(items) { scheduled = items; host.invalidateUi?.(); },
    settings: {
      timeoutMs: 120000,
      actions: ["manage", "rebuildSemantic", "resetSemantic"],
      async act(action, context) {
        if (action.id === "manage") {
          const input = JSON.parse(action.value ?? "{}") as { action: string; scope: string; id?: string; revision?: number; text?: string; offset?: number };
          if (input.scope !== "global" && input.scope !== "project") throw new Error("Invalid memory scope");
          const scope = scopeKey(input.scope, context);
          const database = db.scoped(AbortSignal.any([host.signal, context.signal]));
          if (input.action === "consolidate") return { merged: await database.call("consolidate", [scope]) };
          const offset = input.offset ?? 0;
          if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid offset");
          if (input.action === "list") return { records: await database.call("list", [scope], "", true, offset), jobs: await database.call("jobStatus", [scope]) };
          if (input.action === "add") {
            await database.call("save", { scope, text: content(input.text), status: "active", source: JSON.stringify({ kind: "settings-entry", interactionId: randomUUID() }) });
          } else {
            if (!input.id) throw new Error("Memory ID required");
            if (input.action === "history") return database.call("history", scope, input.id, offset);
            if (!Number.isSafeInteger(input.revision) || input.revision! < 1) throw new Error("Revision required");
            if (input.action === "confirm") await database.call("confirm", scope, input.id, input.revision!);
            else if (input.action === "forget") await database.call("forget", scope, input.id, input.revision!);
            else if (input.action === "move") await database.call("move", scope, input.id, input.revision!, scopeKey(input.scope === "global" ? "project" : "global", context));
            else if (input.action === "edit") await database.call("save", { scope, id: input.id, expectedRevision: input.revision!, text: content(input.text), status: "active", source: JSON.stringify({ kind: "settings-edit", interactionId: randomUUID(), previousRevision: input.revision }) });
            else throw new Error("Unknown memory action");
          }
          host.invalidateUi?.();
          return { ok: true };
        }
        const project = action.value === "project";
        if (project && !context.projectId) throw new Error("Select a project first");
        const config = await host.config?.read(project ? context.projectId : undefined);
        if (config?.values.semanticRecall !== true) throw new Error("Enable and save semantic recall first");
        const scopes = project ? ["global", `project:${context.projectId}`] : ["global"];
        const signal = AbortSignal.any([host.signal, context.signal]);
        if (action.id === "resetSemantic") await db.scoped(signal).call("clearVectors", scopes);
        return rebuildVectors(db, scopes, config.values, signal);
      },
    },
    async validateSkillSource(reference, context) {
      const source = JSON.parse(reference) as { scope: string; id: string; revision: number };
      if (source.scope !== "global" && source.scope !== `project:${context.projectId}`) return false;
      const result = await execute({ action: "validate", scope: source.scope === "global" ? "global" : "project", id: source.id, revision: source.revision }, context) as { usable: boolean };
      return result.usable === true;
    },
    async sessionDeleted(event, signal) {
      const database = db.scoped(AbortSignal.any([host.signal, signal]));
      const scopes = ["global", `project:${event.projectId}`];
      if (event.forgetDerivedData) await database.call("forgetSession", scopes, event.sessionId);
      else for (const scope of scopes) await database.call("cancelSessionJobs", scope, event.sessionId);
      historyViews.delete(event.sessionId);
      detailViews.delete(event.sessionId);
      draftViews.delete(event.sessionId);
    },
    async runCompleted(event, services) {
      const database = db.scoped(AbortSignal.any([host.signal, services.signal]));
      assertActive(services);
      const config = await host.config?.read(event.projectId);
      if (config?.values.automaticLearning !== true && event.trigger !== "manual") return;
      assertActive(services);
      const scope = `project:${event.projectId}`;
      const latestUser = [...event.messages].reverse().find(message => message.role === "user");
      if (rememberIntent(latestUser?.text) === "denied") {
        await database.call("cancelRunJob", scope, event.sessionId, event.runId);
        return;
      }
      const snapshot = { truncated: event.truncated ?? false, evidence: event.messages.filter(message => message.role === "user" || message.role === "tool").slice(-12).map(message => ({ ...message, text: message.text.replace(/\b(?:sk|ghp|github_pat)[-_][a-zA-Z0-9_-]{16,}|\bBearer\s+\S{16,}/gi, "[REDACTED]") })) };
      await database.call("enqueueEvidence", scope, event.sessionId, event.runId, JSON.stringify(snapshot));
      const job = await database.call("claim", [scope], Date.now(), { sessionId: event.sessionId, cursor: event.runId });
      if (!job) {
        if (await database.call("jobSettled", scope, event.sessionId, event.runId)) return;
        throw new Error("Extraction pending; retry after lease or backoff");
      }
      activityChanged(activityKey(event.projectId, event.sessionId), event.runId, "running");
      const cancelled = () => activityChanged(activityKey(event.projectId, event.sessionId), event.runId, "error");
      services.signal.addEventListener("abort", cancelled, { once: true });
      try {
        const stored = JSON.parse(await database.call("jobEvidence", job.id, job.leaseToken)) as typeof snapshot;
        const evidence = stored.evidence;
        await database.call("consolidate", [scope, "global"]);
        const related = await database.call("list", [scope, "global"], evidence.map(message => message.text).join(" ").slice(0, 1000), true);
        const recent = await database.call("list", [scope, "global"], "", true);
        const compared = [...new Map([...related.slice(0, 10), ...recent].filter(record => record.status === "active" || record.status === "candidate").map(record => [record.id, record])).values()];
        const prompt = extractionPrompt({ truncated: stored.truncated, evidence }, compared);
        const existing = prompt.existing;
        let reportedUsage: { inputTokens: number; outputTokens: number } | undefined;
        const output = await services.generate(prompt.instructions, usage => { reportedUsage = usage; });
        assertActive(services);
        if (reportedUsage) await database.call("jobResult", job.id, "模型调用完成", reportedUsage);
        const parsed = parseExtractionResponse(output) as { duplicates?: { keep: { id: string; revision: number }; remove: { id: string; revision: number } }[]; memories?: { text: string; sourceId: string; scope?: "global" | "project"; replaces?: { id: string; revision: number }; experience?: MemoryExperience }[] };
        if (!Array.isArray(parsed.memories) || parsed.memories.length > 5) throw new Error("Invalid extraction response");
        const candidates = parsed.memories.map(item => {
          if (item.scope !== undefined && item.scope !== "global" && item.scope !== "project") throw new Error("Invalid extraction scope");
          if (item.scope === "global" && (item.experience || !evidence.some(message => message.id === item.sourceId && message.role === "user"))) throw new Error("Global preferences require user evidence");
          if (!evidence.some(message => message.id === item.sourceId)) throw new Error("Unknown extraction source");
          if (item.replaces && !existing.some(record => record.id === item.replaces!.id && record.revision === item.replaces!.revision)) throw new Error("Unknown replacement target");
          const experience = item.experience ? validateExperience(item.experience, evidence) : undefined;
          if (experience && item.sourceId !== experience.verification.sourceId) throw new Error("Experience primary source must be its verification");
          return { text: content(experience ? experienceText(experience) : item.text), sourceId: item.sourceId, ...(item.scope ? { scope: item.scope } : {}), ...(item.replaces ? { replaces: item.replaces } : {}), ...(experience ? { experience } : {}) };
        });
        const duplicates = parsed.duplicates ?? [];
        if (!Array.isArray(duplicates) || duplicates.length > 5 || duplicates.some(pair => !pair?.keep || !pair?.remove || ![pair.keep, pair.remove].every(ref => existing.some(record => !record.truncated && record.id === ref.id && record.revision === ref.revision)))) throw new Error("Invalid duplicate references");
        const retained = await database.call("commitJob", job.id, job.leaseToken, candidates, Date.now(), config?.values.requireReview !== false, duplicates);
        await database.call("jobResult", job.id, `已处理 ${retained} 条新记忆，检查 ${duplicates.length} 组同义重复；需复核的内容保留待确认`);
        activityChanged(activityKey(event.projectId, event.sessionId), event.runId, "success");
        host.invalidateUi?.();
      } catch (error) {
        activityChanged(activityKey(event.projectId, event.sessionId), event.runId, "error");
        if (!host.signal.aborted) {
          await database.call("jobResult", job.id, services.signal.aborted ? "处理已取消" : "提取失败：模型响应、来源校验或存储未通过；等待重试");
          try { await database.call("finishJob", job.id, job.leaseToken, false); } catch { /* revoked/expired */ }
          host.invalidateUi?.();
        }
        throw error;
      } finally { services.signal.removeEventListener("abort", cancelled); }
    },
    tools: [{ definition, execute }, historyTool(host)],
    contextProviders: [{ async provide(request) {
      const database = db.scoped(AbortSignal.any([host.signal, request.signal]));
      assertActive(request);
      const config = await host.config?.read(request.projectId);
      assertActive(request);
      const scopes = [ ...(config?.values.useGlobal !== false ? ["global"] : []), ...(request.projectId && config?.values.useProject !== false ? [`project:${request.projectId}`] : []) ];
      let records = (await database.call("list", scopes, request.query)).slice(0, 12);
      if (config?.values.semanticRecall === true && scopes.length) {
        const indexKey = JSON.stringify([scopes, config.values.embeddingEndpoint, config.values.embeddingModel]);
        if (host.runBackground && !indexing.has(indexKey) && Date.now() - (lastIndexAttempt.get(indexKey) ?? 0) > 60000) {
          indexing.add(indexKey);
          if (lastIndexAttempt.size >= 100) lastIndexAttempt.delete(lastIndexAttempt.keys().next().value!);
          lastIndexAttempt.set(indexKey, Date.now());
          try {
            host.runBackground({ ...request, label: "更新记忆语义索引" }, async signal => {
              try { await rebuildVectors(db, scopes, config.values, AbortSignal.any([signal, AbortSignal.timeout(60000)])); }
              catch { /* Optional local service failure must not stop ordinary recall. */ }
              finally { indexing.delete(indexKey); }
            });
          } catch { indexing.delete(indexKey); }
        }
        try { records = fuseRecall(records, await semanticRecall(db, scopes, config.values, request.query, AbortSignal.any([host.signal, request.signal, AbortSignal.timeout(700)]))); }
        catch { assertActive(request); /* Continue with keyword results. */ }
      }
      const current = (await Promise.all(records.map(async record => {
        const latest = await database.call("get", record.scope, record.id);
        return latest?.revision === record.revision && latest.status === "active" ? latest : null;
      }))).filter((record): record is NonNullable<typeof record> => record !== null);
      return Promise.all(current.map(async record => ({ id: record.id, revision: record.revision,
        text: `[${record.scope}; ${await checkRecordDependencies(record, request) ? "dependency check passed or not applicable" : "STALE: dependency changed/missing; verify before using"}; source=${record.source}; updated=${record.updatedAt}] ${record.text}` })));
    } }],
    ui: [{ id: "modera.memory.panel", slot: "panel", icon: "box", requiredPermissions: permissions,
      actions: ["details", "addGlobal", "addProject", "confirm", "forget", "edit", "moveGlobal", "moveProject", "next", "previous", "history", "closeHistory", "draftSkill", "exportSkill", "closeDraft"],
      async act(action, context) {
        const database = db.scoped(AbortSignal.any([host.signal, context.signal]));
        assertActive(context);
        if (action.id === "details") {
          const id = action.value ?? "";
          if (detailViews.get(context.sessionId) === id) detailViews.delete(context.sessionId);
          else {
            if (detailViews.size >= 100) detailViews.delete(detailViews.keys().next().value!);
            detailViews.set(context.sessionId, id);
          }
          host.invalidateUi?.(context.sessionId);
          return;
        }
        if (action.id === "next" || action.id === "previous") {
          pages.set(context.sessionId, Math.max(0, (pages.get(context.sessionId) ?? 0) + (action.id === "next" ? 100 : -100)));
          if (pages.size > 100) pages.delete(pages.keys().next().value!);
          host.invalidateUi?.(context.sessionId);
          return;
        }
        if (action.id === "addGlobal" || action.id === "addProject") {
          await database.call("save", { scope: scopeKey(action.id === "addGlobal" ? "global" : "project", context), text: content(action.value), status: "active", source: JSON.stringify({ sessionId: context.sessionId, interactionId: randomUUID(), kind: "user-entry" }) });
        } else {
          const envelope = JSON.parse(action.value ?? "{}");
          const value = (action.id === "edit" ? { ...JSON.parse(envelope.context), text: envelope.text } : envelope) as { id: string; revision: number; scope: string; text?: string };
          if (value.scope !== "global" && value.scope !== (context.projectId ? `project:${context.projectId}` : undefined)) throw new Error("Memory scope denied");
          if (action.id === "draftSkill") {
            const result = await execute({ action: "draft_skill", scope: value.scope === "global" ? "global" : "project", id: value.id, revision: value.revision }, context) as { draft: { id: string } };
            if (draftViews.size >= 100) draftViews.delete(draftViews.keys().next().value!);
            draftViews.set(context.sessionId, { scope: value.scope, id: result.draft.id });
          }
          else if (action.id === "closeDraft") draftViews.delete(context.sessionId);
          else if (action.id === "exportSkill") {
            const result = await execute({ action: "export_skill", scope: value.scope === "global" ? "global" : "project", id: value.id }, context) as { path: string };
            draftViews.set(context.sessionId, { scope: value.scope, id: value.id, exportPath: result.path });
          }
          else if (action.id === "history" || action.id === "closeHistory") {
            const offset = (envelope as { offset?: number }).offset ?? 0;
            if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid history offset");
            if (action.id === "closeHistory") historyViews.delete(context.sessionId);
            else {
              if (historyViews.size >= 100) historyViews.delete(historyViews.keys().next().value!);
              historyViews.set(context.sessionId, { scope: value.scope, id: value.id, offset });
            }
          }
          else if (action.id === "forget") await database.call("forget", value.scope, value.id, value.revision);
          else if (action.id === "confirm") await database.call("confirm", value.scope, value.id, value.revision);
          else if (action.id === "moveGlobal" || action.id === "moveProject") await database.call("move", value.scope, value.id, value.revision, scopeKey(action.id === "moveGlobal" ? "global" : "project", context));
          else {
            const record = await database.call("get", value.scope, value.id);
            if (!record) throw new Error("Memory not found");
            const source = action.id === "confirm" ? record.source : JSON.stringify({ sessionId: context.sessionId, interactionId: randomUUID(), kind: "user-edit", previousRevision: record.revision });
            await database.call("save", { scope: value.scope, id: value.id, expectedRevision: value.revision, text: content(value.text ?? record.text), status: "active", source });
          }
        }
        host.invalidateUi?.();
      },
      async render(_request, context) {
        const database = db.scoped(AbortSignal.any([host.signal, context.signal]));
        assertActive(context);
        const scopes = ["global", ...(context.projectId ? [`project:${context.projectId}`] : [])];
        const offset = pages.get(context.sessionId) ?? 0;
        const records = await database.call("list", scopes, "", true, offset);
        const corrections = new Map<string, string>();
        const draftable = new Set<string>();
        for (const record of records) {
          try { if (record.status === "active" && JSON.parse(record.source).experience) draftable.add(record.id); } catch { /* legacy source */ }
          if (record.status !== "candidate") continue;
          let replacement: { id: string; revision: number } | undefined;
          try { replacement = JSON.parse(record.source).replaces; } catch { /* legacy source */ }
          if (!replacement) continue;
          const target = await database.call("get", record.scope, replacement.id);
          corrections.set(record.id, target?.revision === replacement.revision && target.status === "active"
            ? `更正建议：确认后替代 v${target.revision}「${target.text}」`
            : "更正目标已变化或删除，请重新检查；此建议不能直接确认。");
        }
        const children: PluginUiNode[] = [
          { type: "text", text: "待确认的内容不会用于回答。确认后，AI 可在后续对话中参考；不准确的内容请编辑或删除。", tone: "muted" },
          ...scopes.flatMap(scope => [
          { type: "text" as const, text: scope === "global" ? "全局记忆 · 可供所有项目使用" : "项目记忆 · 仅供当前项目使用" },
          { type: "form" as const, label: "添加记忆", placeholder: scope === "global" ? "添加长期偏好，例如：默认用中文回答" : "添加项目约定，例如：使用 pnpm 构建", action: scope === "global" ? "addGlobal" : "addProject", maxLength: 4000 },
          ...(!records.some(record => record.scope === scope) ? [{ type: "text" as const, text: "暂无记忆。手动添加后直接启用，后台学习的建议需确认。", tone: "muted" as const }] : []),
          ...records.filter(record => record.scope === scope).map(record => ({ type: "stack" as const, children: [
            { type: "document" as const, text: record.text, label: ({ candidate: "待确认 · 尚未用于回答", active: "已启用", superseded: "已替代 · 不再使用", stale: "待验证 · 请检查内容" })[record.status], meta: record.updatedAt.slice(0, 10) },
            { type: "row" as const, children: [
              ...(record.status === "candidate" ? [{ type: "button" as const, label: "确认使用", action: "confirm", value: JSON.stringify({ id: record.id, scope: record.scope, revision: record.revision }) }] : []),
              { type: "button" as const, label: detailViews.get(context.sessionId) === record.id ? "收起详情" : "编辑与详情", action: "details", value: record.id },
            ] },
            ...(corrections.has(record.id) ? [{ type: "text" as const, text: corrections.get(record.id)! }] : []),
            ...(detailViews.get(context.sessionId) === record.id ? [
            ...sourceLink(record.source),
            ...(draftable.has(record.id) ? [{ type: "button" as const, label: "生成 Skill 草稿", action: "draftSkill", value: JSON.stringify({ id: record.id, scope: record.scope, revision: record.revision }) }] : []),
            { type: "button" as const, label: "查看版本历史", action: "history", value: JSON.stringify({ id: record.id, scope: record.scope }) },
            { type: "form" as const, label: "保存修改", placeholder: "编辑记忆", action: "edit", initialValue: record.text, context: JSON.stringify({ id: record.id, scope: record.scope, revision: record.revision }), maxLength: 4000 },
            ...(record.scope !== "global" ? [{ type: "button" as const, label: "提升为全局记忆（供所有项目使用）", action: "moveGlobal", value: JSON.stringify({ id: record.id, scope: record.scope, revision: record.revision }) }] : context.projectId ? [{ type: "button" as const, label: "限定为当前项目记忆", action: "moveProject", value: JSON.stringify({ id: record.id, scope: record.scope, revision: record.revision }) }] : []),
            { type: "text" as const, text: "保存修改会直接启用新内容；删除仅移除长期记忆，原对话仍保留。", tone: "muted" as const },
            { type: "button" as const, label: "删除长期记忆", action: "forget", value: JSON.stringify({ id: record.id, scope: record.scope, revision: record.revision }) },
            ] : []),
          ] })),
        ])];
        const selectedDraft = draftViews.get(context.sessionId);
        if (selectedDraft && scopes.includes(selectedDraft.scope)) {
          const result = await execute({ action: "read_draft", scope: selectedDraft.scope === "global" ? "global" : "project", id: selectedDraft.id }, context) as { draft: { content: string; stale: boolean; memoryRevision: number } | null };
          if (result.draft) children.push({ type: "document", label: result.draft.stale ? "Skill 草稿已过期，请重新验证" : "Skill 草稿（未安装、未启用）", text: result.draft.content, meta: `来源记忆 v${result.draft.memoryRevision}` });
          else children.push({ type: "text", text: "草稿来源已删除或移出当前范围。" });
          if (result.draft && !result.draft.stale) children.push({ type: "button", label: "导出 SKILL.md", action: "exportSkill", value: JSON.stringify(selectedDraft) });
          if (selectedDraft.exportPath) children.push({ type: "document", label: "Skill 文件路径", text: selectedDraft.exportPath, meta: "通过现有技能安装入口导入。导出副本不会随记忆修改或删除。" });
          if (selectedDraft.exportPath && result.draft && !result.draft.stale) children.push({ type: "skill-import", label: "导入此 Skill（默认停用）", path: selectedDraft.exportPath });
          children.push({ type: "button", label: "关闭 Skill 草稿", action: "closeDraft", value: JSON.stringify(selectedDraft) });
        }
        const selectedHistory = historyViews.get(context.sessionId);
        if (selectedHistory && scopes.includes(selectedHistory.scope)) {
          const revisions = await database.call("history", selectedHistory.scope, selectedHistory.id, selectedHistory.offset);
          children.push({ type: "text", text: `版本历史 · 第 ${Math.floor(selectedHistory.offset / 20) + 1} 页` });
          for (const revision of revisions) children.push({ type: "stack", children: [
            { type: "document", label: `v${revision.revision} · ${revision.status}`, text: revision.text, meta: revision.updatedAt.slice(0, 10) },
            ...sourceLink(revision.source),
          ] });
          if (!revisions.length) children.push({ type: "text", text: "没有可访问的历史版本，记忆可能已删除或移出当前范围。" });
          if (selectedHistory.offset > 0) children.push({ type: "button", label: "较新版本", action: "history", value: JSON.stringify({ ...selectedHistory, offset: Math.max(0, selectedHistory.offset - 20) }) });
          if (revisions.length === 20) children.push({ type: "button", label: "较早版本", action: "history", value: JSON.stringify({ ...selectedHistory, offset: selectedHistory.offset + 20 }) });
          children.push({ type: "button", label: "关闭版本历史", action: "closeHistory", value: JSON.stringify(selectedHistory) });
        }
        children.push({ type: "text", text: `第 ${Math.floor(offset / 100) + 1} 页 · 本页 ${records.length} 条` });
        children.push({ type: "text", text: "最近后台学习（供应商报告用量累计；未报告不计为零）" });
        for (const job of await database.call("jobStatus", scopes)) children.push({ type: "text", text: `${job.state} · 尝试 ${job.attempts} 次 · ${job.detail ?? "等待处理"} · 输入 ${job.inputTokens ?? "未知"} / 输出 ${job.outputTokens ?? "未知"} tokens` });
        if (offset) children.push({ type: "button", label: "上一页", action: "previous" });
        if (records.length === 100) children.push({ type: "button", label: "下一页", action: "next" });
        return { title: "记忆", width: "wide", badge: records.some(record => record.status === "candidate") ? `${records.filter(record => record.status === "candidate").length} 待确认` : `${records.length} 条`, children };
      },
    }, { id: "modera.memory.activity", slot: "window.overlay", requiredPermissions: permissions, actions: [], async render(request, context) {
      const entry = learningActivity.get(activityKey(context.projectId, context.sessionId));
      const manual = manualRequests.has(context.sessionId);
      const config = await host.config?.read(context.projectId);
      const pending = config?.values.automaticLearning === true ? scheduled.filter(item => item.projectId === context.projectId).sort((a, b) => (a.checkAt ?? Infinity) - (b.checkAt ?? Infinity))[0] : undefined;
      if (!manual && !entry?.running.size && (!entry || Date.now() - entry.updatedAt >= 8000) && pending) return { title: request.locale.startsWith("zh") ? "等待提取记忆" : "Memory extraction queued", surface: { html: activityDocument }, live: true, data: { activity: { state: "waiting" as const, queuedAt: pending.queuedAt, ...(pending.checkAt === undefined ? {} : { checkAt: pending.checkAt }), detail: request.locale.startsWith("zh") ? "预计下一次队列检查时间；队列繁忙时可能延后" : "Estimated queue check; busy queues may delay extraction" } }, children: [] };
      const state = manual ? "running" : entry && (entry.running.size || Date.now() - entry.updatedAt < 8000) ? entry.state : "idle";
      const zh = request.locale.startsWith("zh");
      return { title: state === "running" ? (zh ? "正在整理记忆" : "Organizing memories") : state === "success" ? (zh ? "记忆整理完成" : "Memory updated") : state === "error" ? (zh ? "记忆整理未完成" : "Memory update interrupted") : "", surface: { html: activityDocument }, live: state !== "idle", data: { activity: { state } }, children: [] };
    } }, { id: "modera.memory.extract", slot: "conversation.composer", requiredPermissions: [...permissions, "runs.observe", "models.generate"], actions: ["extract"],
      async render(request, context) {
        const running = !!learningActivity.get(activityKey(context.projectId, context.sessionId))?.running.size || manualRequests.has(context.sessionId);
        return { title: request.locale.startsWith("zh") ? "提取记忆" : "Extract memory", surface: { html: composerDocument, width: 70, height: 96 }, data: { running }, live: running, badge: running ? "running" : "idle", children: [{ type: "button", label: "Extract", action: "extract" }] };
      },
      async act(action, context) {
        if (action.id !== "extract" || !host.requestObservation || !host.runBackground) throw new Error("Manual extraction unavailable");
        const selection = z.object({ profileId: z.string().min(1).max(200), model: z.string().min(1).max(200), reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]) }).strict().parse(JSON.parse(action.value ?? "{}"));
        if (manualRequests.has(context.sessionId) || learningActivity.get(activityKey(context.projectId, context.sessionId))?.running.size) throw new Error("Extraction already running");
        manualRequests.add(context.sessionId);
        try { host.runBackground({ ...context, label: "Manual memory extraction" }, async signal => {
          const startedAt = Date.now();
          try {
            await host.requestObservation!({ ...context, signal }, selection);
            activityChanged(activityKey(context.projectId, context.sessionId), context.runId, "success");
          }
          catch { activityChanged(activityKey(context.projectId, context.sessionId), context.runId, "error"); }
          finally {
            // Keep even an idempotent result observable for one lever stroke.
            await delay(Math.max(0, 850 - (Date.now() - startedAt)), undefined, { signal }).catch(() => {});
            manualRequests.delete(context.sessionId);
            host.invalidateUi?.(context.sessionId);
          }
        }); } catch (error) { manualRequests.delete(context.sessionId); throw error; }
        host.invalidateUi?.(context.sessionId);
      },
    }],
  };
};
