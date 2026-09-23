import { memorySettings } from "./settings-api";
import { useEffect, useState } from "react";
import { Button, frontend } from "@modera/plugin-sdk/react";

interface RecordValue {
  id: string;
  text: string;
  revision: number;
  status: string;
  source: string;
  updatedAt: string;
}
interface Result {
  records: RecordValue[];
  jobs: { state: string; detail?: string; attempts: number }[];
}
export function MemoryList({
  scope,
  projectId,
  zh,
}: {
  scope: "global" | "project";
  projectId: string | null | undefined;
  zh: boolean;
}) {
  const t = (cn: string, en: string) => (zh ? cn : en);
  const [data, setData] = useState<Result>({ records: [], jobs: [] });
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<RecordValue | "new" | null>(null);
  const [text, setText] = useState("");
  const [history, setHistory] = useState<{
    id: string;
    offset: number;
    records: RecordValue[];
  }>();
  useEffect(() => {
    setOffset(0);
    setEditing(null);
    setHistory(undefined);
  }, [scope, projectId]);
  useEffect(() => {
    let alive = true;
    setBusy(true);
    setError("");
    setData({ records: [], jobs: [] });
    void memorySettings
      .action("manage", JSON.stringify({ action: "list", scope, offset }))
      .then((value) => {
        if (alive) setData(value as Result);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [scope, projectId, offset, refresh]);
  async function act(action: string, record?: RecordValue, page = 0) {
    setBusy(true);
    setError("");
    try {
      const value = await memorySettings.action(
        "manage",
        JSON.stringify({
          action,
          scope,
          id: record?.id,
          revision: record?.revision,
          text,
          offset: page,
        }),
      );
      if (action === "history")
        setHistory({
          id: record!.id,
          offset: page,
          records: value as RecordValue[],
        });
      else if (action === "consolidate") {
        setNotice(
          t(
            `已合并 ${(value as { merged: number }).merged} 条完全重复记忆。同义内容会在后台学习时继续整理。`,
            `Merged ${(value as { merged: number }).merged} exact duplicates. Semantic duplicates are reviewed during background learning.`,
          ),
        );
        setRefresh((v) => v + 1);
      } else {
        setEditing(null);
        setHistory(undefined);
        setRefresh((v) => v + 1);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const editor = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void act(
          editing === "new" ? "add" : "edit",
          editing && editing !== "new" ? editing : undefined,
        );
      }}
    >
      <textarea
        aria-label={t("记忆内容", "Memory content")}
        required
        maxLength={4000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
      />
      <div className="df-row">
        <button className="df-button primary" disabled={busy || !text.trim()}>
          {t("保存并记住", "Save memory")}
        </button>
        <Button disabled={busy} onClick={() => setEditing(null)}>
          {t("取消", "Cancel")}
        </Button>
      </div>
    </form>
  );
  function recordView(record: RecordValue) {
    let source: {
      kind?: string;
      sessionId?: string;
      messageId?: string;
      replaces?: { id: string; revision: number };
    } = {};
    try {
      source = JSON.parse(record.source);
    } catch {
      /* legacy */
    }
    return (
      <article className="memory-record" key={record.id}>
        <div className="memory-record-body">
          {editing !== "new" && editing?.id === record.id ? (
            editor
          ) : (
            <p>{record.text}</p>
          )}
          {source.replaces && (
            <p className="df-muted">
              {t(
                "更正建议：确认后替代旧记忆，请先检查来源和版本。",
                "Correction: confirmation replaces the previous memory. Review its source and revision first.",
              )}
            </p>
          )}
          <details>
            <summary>
              {t("来源与历史", "Source and history")} ·{" "}
              {record.updatedAt.slice(0, 10)}
            </summary>
            <p className="df-muted">
              {source.kind?.startsWith("settings")
                ? t("在设置中手动记录", "Manually recorded in settings")
                : source.sessionId
                  ? t("来自对话", "From conversation")
                  : t("历史记录", "Historical record")}{" "}
              · v{record.revision}
            </p>
            {source.sessionId && (
              <p className="df-muted">
                {t("来源对话 ID：", "Conversation ID: ")}
                {source.sessionId}
                {source.messageId ? ` / ${source.messageId}` : ""}
              </p>
            )}
            <Button disabled={busy} onClick={() => void act("history", record)}>
              {t("查看版本历史", "Version history")}
            </Button>
            {record.status === "candidate" && (
              <Button
                disabled={busy}
                onClick={() => {
                  setEditing(record);
                  setText(record.text);
                }}
              >
                {t("编辑后记住", "Edit before saving")}
              </Button>
            )}
            <Button
              disabled={busy || (!projectId && scope === "global")}
              onClick={() => void act("move", record)}
            >
              {scope === "global"
                ? t("移到当前项目", "Move to project")
                : t("移到全局", "Move to global")}
            </Button>
            {history?.id === record.id && (
              <div>
                {history.records.map((r) => (
                  <p key={r.revision}>
                    v{r.revision} · {r.text}
                  </p>
                ))}
                <div className="df-row">
                  {history.offset > 0 && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void act("history", record, history.offset - 20)
                      }
                    >
                      {t("较新版本", "Newer")}
                    </Button>
                  )}
                  {history.records.length === 20 && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void act("history", record, history.offset + 20)
                      }
                    >
                      {t("较早版本", "Older")}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </details>
        </div>
        <div className="memory-record-actions">
          {record.status === "candidate" ? (
            <>
              <Button
                className="df-button primary"
                disabled={busy}
                onClick={() => void act("confirm", record)}
              >
                {t("记住", "Remember")}
              </Button>
              <Button
                disabled={busy}
                onClick={() => void act("forget", record)}
              >
                {t("忽略", "Dismiss")}
              </Button>
            </>
          ) : (
            <details>
              <summary aria-label={t("更多操作", "More actions")}>•••</summary>
              <div className="df-row">
                <Button
                  disabled={busy}
                  onClick={() => {
                    setEditing(record);
                    setText(record.text);
                  }}
                >
                  {t("编辑", "Edit")}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => void act("forget", record)}
                >
                  {t("删除", "Delete")}
                </Button>
              </div>
            </details>
          )}
        </div>
      </article>
    );
  }
  return (
    <section
      className="memory-library"
      aria-label={t("记忆管理", "Manage memories")}
    >
      <header>
        <span className="df-muted">
          {scope === "global"
            ? t("在所有项目中使用", "Used across all projects")
            : t("仅在当前项目中使用", "Used in the current project only")}
        </span>
        <Button
          disabled={busy}
          onClick={() => {
            setText("");
            setEditing("new");
          }}
        >
          {t("添加记忆", "Add memory")}
        </Button>
      </header>
      {editing === "new" && editor}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {busy && (
        <p role="status" className="df-muted">
          {t("正在处理…", "Working…")}
        </p>
      )}
      {data.records.some((r) => r.status === "candidate") && (
        <>
          <h3>
            {t("待确认", "Needs review")} ·{" "}
            {data.records.filter((r) => r.status === "candidate").length}
          </h3>
          <p className="df-muted">
            {t(
              "确认后才会用于后续回答。",
              "Only used in future answers after confirmation.",
            )}
          </p>
          <div className="memory-candidates">
            {data.records
              .filter((r) => r.status === "candidate")
              .map(recordView)}
          </div>
        </>
      )}
      <h3>
        {t("已记住", "Saved memories")} ·{" "}
        {data.records.filter((r) => r.status === "active").length}
      </h3>
      {data.records.filter((r) => r.status === "active").map(recordView)}
      {!busy && !data.records.some((r) => r.status === "active") && (
        <p className="df-muted">
          {t("还没有已确认的记忆。", "No confirmed memories yet.")}
        </p>
      )}
      {data.records.some(
        (r) => !["active", "candidate"].includes(r.status),
      ) && (
        <details>
          <summary>
            {t("已替代或待验证的记忆", "Superseded or unverified memories")}
          </summary>
          {data.records
            .filter((r) => !["active", "candidate"].includes(r.status))
            .map(recordView)}
        </details>
      )}
      <div className="df-row">
        {offset > 0 && (
          <Button disabled={busy} onClick={() => setOffset((v) => v - 100)}>
            {t("上一页", "Previous")}
          </Button>
        )}
        {data.records.length === 100 && (
          <Button disabled={busy} onClick={() => setOffset((v) => v + 100)}>
            {t("下一页", "Next")}
          </Button>
        )}
      </div>
      <details className="memory-maintenance">
        <summary>{t("记忆维护", "Memory maintenance")}</summary>
        <div>
          <Button disabled={busy} onClick={() => void act("consolidate")}>
            {t("整理完全重复的记忆", "Consolidate exact duplicates")}
          </Button>
          <details className="memory-log">
            <summary>{t("最近学习记录", "Recent learning activity")}</summary>
            {data.jobs.length ? (
              data.jobs.map((job, i) => (
                <p key={i}>
                  {(
                    {
                      done: t("完成", "Completed"),
                      pending: t("等待处理", "Pending"),
                      running: t("处理中", "Running"),
                      failed: t("失败", "Failed"),
                      cancelled: t("已取消", "Cancelled"),
                    } as Record<string, string>
                  )[job.state] ?? job.state}{" "}
                  · {job.detail} ·{" "}
                  {t(`尝试 ${job.attempts} 次`, `${job.attempts} attempts`)}
                </p>
              ))
            ) : (
              <p>{t("暂无学习记录。", "No learning activity yet.")}</p>
            )}
          </details>
        </div>
      </details>
    </section>
  );
}
