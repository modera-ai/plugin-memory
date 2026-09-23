import { memorySettings } from "./settings-api";
import { useEffect, useRef, useState } from "react";
import {
  mountPlugin,
  SettingsPage,
  SettingsCard,
  Button,
  frontend,
  usePluginSnapshot,
} from "@modera/plugin-sdk/react";
import type {
  PluginConfigSnapshot,
  PluginConfigValues,
} from "@modera/contracts";
import { MemoryList } from "./memory-list";

function MemorySettings() {
  const { snapshot, error } = usePluginSnapshot();
  const zh = snapshot?.locale.startsWith("zh") ?? true;
  const t = (cn: string, en: string) => (zh ? cn : en);
  const [scope, setScope] = useState<"global" | "project">("global");
  const [config, setConfig] = useState<PluginConfigSnapshot>();
  const [overrides, setOverrides] = useState<PluginConfigValues>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const configRef = useRef<PluginConfigSnapshot | undefined>(undefined);
  const draftRef = useRef<PluginConfigValues>({});
  const loadedScope = useRef(scope);
  const saves = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushRef = useRef<() => Promise<boolean>>(async () => true);
  const mounted = useRef(true);
  function persist(): Promise<boolean> {
    clearTimeout(timer.current);
    const next = draftRef.current;
    const targetScope = scope;
    const work = saves.current.then(async () => {
      const current = configRef.current;
      if (!current || loadedScope.current !== targetScope) return true;
      if (JSON.stringify(current.overrides) === JSON.stringify(next))
        return true;
      try {
        await memorySettings.save(current.revision, next, targetScope);
        const saved = await memorySettings.read(targetScope);
        configRef.current = saved;
        if (mounted.current) {
          setConfig(saved);
          if (draftRef.current === next) {
            setFailed(false);
            setMessage(t("已保存", "Saved"));
          }
        }
        return true;
      } catch (cause) {
        if (mounted.current) {
          setFailed(true);
          setMessage(String(cause));
        }
        return false;
      }
    });
    saves.current = work;
    return work;
  }
  flushRef.current = persist;
  function updateOverrides(
    update: (previous: PluginConfigValues) => PluginConfigValues,
  ) {
    const next = update(draftRef.current);
    const textChanged = Object.keys(next).some(
      (key) =>
        typeof next[key] === "string" && next[key] !== draftRef.current[key],
    );
    draftRef.current = next;
    setOverrides(next);
    setMessage("");
    setFailed(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => void flushRef.current(),
      textChanged ? 450 : 0,
    );
  }
  async function switchScope(next: "global" | "project") {
    if (next === scope || busy) return;
    setBusy(true);
    if (await persist()) setScope(next);
    else setBusy(false);
  }
  useEffect(() => {
    mounted.current = true;
    const flush = () => {
      void flushRef.current();
    };
    window.addEventListener("focusout", flush);
    return () => {
      window.removeEventListener("focusout", flush);
      clearTimeout(timer.current);
      void flushRef.current();
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!message || failed) return;
    const timeout = setTimeout(() => setMessage(""), 2200);
    return () => clearTimeout(timeout);
  }, [message, failed]);
  const projectId = (
    snapshot?.view.data as { projectId?: string | null } | undefined
  )?.projectId;
  useEffect(() => {
    let alive = true;
    setBusy(true);
    setConfig(undefined);
    setMessage("");
    setFailed(false);
    void memorySettings
      .read(scope)
      .then((value) => {
        if (alive) {
          configRef.current = value;
          loadedScope.current = scope;
          draftRef.current = value.overrides;
          setConfig(value);
          setOverrides(value.overrides);
        }
      })
      .catch((cause) => {
        if (alive) {
          setMessage(String(cause));
          setFailed(true);
        }
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [scope, projectId]);
  const options = [
    {
      key: "semanticRecall",
      title: t(
        "本地语义召回（实验性）",
        "Local semantic recall (experimental)",
      ),
      description: t(
        "使用已安装的本地 Ollama 向量模型补充关键词召回。服务不可用时自动回退；不会自动下载模型。",
        "Supplement keyword recall with an installed local Ollama embedding model. Falls back when unavailable; does not download models.",
      ),
    },
    {
      key: "automaticLearning",
      title: t("后台自动学习", "Automatic learning"),
      description: t(
        "任务完成后提取长期记忆并整理重复内容，会消耗模型额度。有完整来源的新记忆自动生效，更正和不完整来源需确认。",
        "Extract durable memories and consolidate duplicates after tasks. Uses model quota. Supported new memories activate automatically; corrections and incomplete evidence need review.",
      ),
    },
    {
      key: "requireReview",
      title: t("所有自动记忆都需确认", "Review all automatic memories"),
      description: t(
        "默认关闭。开启后，自动提取的新记忆全部进入待确认，不直接用于回答。",
        "Off by default. When enabled, every extracted memory requires confirmation before recall.",
      ),
    },
    {
      key: "useGlobal",
      title: t("召回全局记忆", "Recall global memory"),
      description: t(
        "在对话中使用跨项目的偏好与通用经验。",
        "Use cross-project preferences and general experience in conversations.",
      ),
    },
    {
      key: "useProject",
      title: t("召回项目记忆", "Recall project memory"),
      description: t(
        "只召回当前项目的约定和经验，不读取其他项目记忆。",
        "Recall conventions and experience from the current project only.",
      ),
    },
  ];
  const renderOption = (option: (typeof options)[number]) => {
    if (!config) return null;
    const explicit = Object.hasOwn(overrides, option.key);
    const effective = config.inherited[option.key];
    return (
      <div key={option.key} className="memory-settings-option">
        <div>
          <strong>{option.title}</strong>
          <p className="df-muted">{option.description}</p>
        </div>
        <select
          aria-label={option.title}
          disabled={busy}
          value={explicit ? String(overrides[option.key]) : "inherit"}
          onChange={(event) =>
            updateOverrides((previous) => {
              const next = { ...previous };
              if (event.target.value === "inherit") delete next[option.key];
              else next[option.key] = event.target.value === "true";
              return next;
            })
          }
        >
          <option value="inherit">
            {t(
              scope === "global" ? "默认" : "继承全局",
              scope === "global" ? "Default" : "Inherit global",
            )}{" "}
            ({effective ? t("开启", "On") : t("关闭", "Off")})
          </option>
          <option value="true">{t("开启", "On")}</option>
          <option value="false">{t("关闭", "Off")}</option>
        </select>
      </div>
    );
  };
  return (
    <SettingsPage title={t("记忆设置", "Memory settings")}>
      <p className="df-description">
        {t(
          "管理长期记忆、自动学习与召回方式",
          "Manage saved memories, automatic learning and recall",
        )}
      </p>
      <section className="memory-scope-panel">
        <div
          className="memory-scope"
          role="group"
          aria-label={t("记忆与设置范围", "Memory and settings scope")}
        >
          <Button
            disabled={busy}
            aria-pressed={scope === "global"}
            onClick={() => void switchScope("global")}
          >
            <span>
              <strong>{t("全局", "Global")}</strong>
              <small>
                {t("所有项目的默认记忆", "Defaults for every project")}
              </small>
            </span>
          </Button>
          <Button
            disabled={busy || !projectId}
            aria-pressed={scope === "project"}
            onClick={() => void switchScope("project")}
          >
            <span>
              <strong>{t("当前项目", "Current project")}</strong>
              <small>
                {projectId
                  ? t("仅影响当前项目", "Only affects this project")
                  : t("未打开项目", "No project open")}
              </small>
            </span>
          </Button>
        </div>
      </section>
      <div className="memory-learning-panel">
        <SettingsCard title={t("学习与召回", "Learning and recall")}>
          <p className="df-muted">
            {scope === "global"
              ? t(
                  "以下是全局默认设置。项目可单独覆盖。",
                  "Global defaults; projects can override these settings.",
                )
              : t(
                  "未覆盖的选项继承全局设置。",
                  "Options without overrides inherit global settings.",
                )}
          </p>
          <section className="memory-option-group">
            <h4>{t("自动学习", "Automatic learning")}</h4>
            {options
              .filter((option) =>
                ["automaticLearning", "requireReview"].includes(option.key),
              )
              .map(renderOption)}
          </section>
          <section className="memory-option-group">
            <h4>{t("召回范围", "Recall sources")}</h4>
            {options
              .filter((option) =>
                ["useGlobal", "useProject"].includes(option.key),
              )
              .map(renderOption)}
          </section>
          <details className="memory-advanced">
            <summary>
              <span>
                <strong>
                  {t("语义召回与索引", "Semantic recall and indexing")}
                </strong>
                <small>
                  {t(
                    "配置本地向量模型及索引维护",
                    "Configure the local embedding model and index maintenance",
                  )}
                </small>
              </span>
              <span aria-hidden="true">⌄</span>
            </summary>
            <div className="memory-advanced-content">
              {options
                .filter((option) => option.key === "semanticRecall")
                .map(renderOption)}
              {config &&
                [
                  {
                    key: "embeddingEndpoint",
                    title: t("本地 Ollama 地址", "Local Ollama URL"),
                  },
                  {
                    key: "embeddingModel",
                    title: t("向量模型", "Embedding model"),
                  },
                ].map((field) => (
                  <div key={field.key} className="memory-model-field">
                    <label>
                      {field.title}
                      <input
                        aria-label={field.title}
                        maxLength={200}
                        disabled={busy}
                        value={String(
                          overrides[field.key] ??
                            config.inherited[field.key] ??
                            "",
                        )}
                        onChange={(event) =>
                          updateOverrides((previous) => ({
                            ...previous,
                            [field.key]: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <Button
                      disabled={busy || !Object.hasOwn(overrides, field.key)}
                      onClick={() =>
                        updateOverrides((previous) => {
                          const next = { ...previous };
                          delete next[field.key];
                          return next;
                        })
                      }
                    >
                      {t("恢复继承", "Inherit")}
                    </Button>
                  </div>
                ))}
              <p className="df-muted">
                {t(
                  "更换模型后会重建对应版本的向量；正文和关键词索引不受影响。",
                  "Changing models rebuilds their vector index; memory content and keyword search are preserved.",
                )}
              </p>
              <div className="memory-index-actions">
                <Button
                  disabled={busy || !config}
                  onClick={() => {
                    setBusy(true);
                    setMessage("");
                    setFailed(false);
                    void persist()
                      .then((saved) => {
                        if (!saved)
                          throw new Error(
                            t(
                              "设置未保存，请修正后重试",
                              "Correct the settings before retrying",
                            ),
                          );
                        return memorySettings.action("rebuildSemantic", scope);
                      })
                      .then((raw) => {
                        const result = raw as {
                          indexed: number;
                          remaining: boolean;
                        };
                        setMessage(
                          t(
                            `已更新 ${result.indexed} 条记忆索引${result.remaining ? "，仍有剩余，请继续更新" : ""}`,
                            `Indexed ${result.indexed} memories${result.remaining ? "; more remain—run again" : ""}`,
                          ),
                        );
                      })
                      .catch((error) => {
                        setFailed(true);
                        setMessage(String(error));
                      })
                      .finally(() => setBusy(false));
                  }}
                >
                  {t("更新语义索引", "Update semantic index")}
                </Button>
                <Button
                  disabled={busy || !config}
                  onClick={() => {
                    setBusy(true);
                    setMessage("");
                    setFailed(false);
                    void persist()
                      .then((saved) => {
                        if (!saved)
                          throw new Error(
                            t(
                              "设置未保存，请修正后重试",
                              "Correct the settings before retrying",
                            ),
                          );
                        return memorySettings.action("resetSemantic", scope);
                      })
                      .then((raw) => {
                        const result = raw as {
                          indexed: number;
                          remaining: boolean;
                        };
                        setMessage(
                          t(
                            `已重建 ${result.indexed} 条${result.remaining ? "，请点击更新语义索引继续" : ""}`,
                            `Rebuilt ${result.indexed}${result.remaining ? "; use Update semantic index to continue" : ""}`,
                          ),
                        );
                      })
                      .catch((error) => {
                        setFailed(true);
                        setMessage(String(error));
                      })
                      .finally(() => setBusy(false));
                  }}
                >
                  {t("重建语义索引", "Rebuild semantic index")}
                </Button>
              </div>
            </div>
          </details>
          {(message || error) && (
            <p role={failed || error ? "alert" : "status"}>
              {message || error}
            </p>
          )}
        </SettingsCard>
      </div>
      <section className="memory-workspace">
        <MemoryList
          key={`${projectId}:${scope}`}
          scope={scope}
          projectId={projectId}
          zh={zh}
        />
      </section>
    </SettingsPage>
  );
}
mountPlugin(<MemorySettings />);
