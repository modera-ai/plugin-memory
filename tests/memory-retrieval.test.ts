import { it, expect } from "vitest";
import { MemoryRepository } from "../src/repository";

// Small lexical regression corpus, not a semantic benchmark or model accuracy claim.
const cases = [
  ["中文", "用户偏好中文回复"], ["构建", "使用专用构建脚本"],
  ["数据库", "数据库迁移需要版本记录"], ["登录", "登录失败先检查凭证是否过期"],
  ["附件", "附件保存到独立目录"], ["回滚", "回滚操作需要保留证据"],
  ["测试", "测试结果以实际退出码为准"], ["缓存", "缓存内容可以重新生成"],
  ["分支", "分支相关经验需要验证"], ["权限", "权限由宿主绑定"],
  ["部署", "部署前检查目标环境"], ["超时", "超时应停止请求"],
  ["检索", "检索仅访问当前项目"], ["记忆", "记忆支持修改删除"],
  ["路径", "路径必须保留完整信息"],
  ["pnpm", "Build using pnpm"], ["EADDRINUSE", "EADDRINUSE means the configured port is occupied"],
  ["SQLITE_BUSY", "Retry SQLITE_BUSY with bounded backoff"], ["src/auth.ts", "Authentication entry is src/auth.ts"],
  ["--dry-run", "Preview migration with --dry-run"], ["Node22", "This environment uses Node22"],
  ["tsconfig", "Path aliases live in tsconfig"], ["ENOENT", "ENOENT indicates a missing resource"],
  ["vite", "The development server uses vite"], ["OAuth", "OAuth sessions can expire"],
  ["403", "A 403 response can indicate denied access"], ["pytest", "Execute Python checks with pytest"],
  ["Cargo.lock", "Preserve Cargo.lock for reproducibility"], ["workspace_id", "Use the host workspace_id"],
  ["UTF-8", "Read project documents using UTF-8"],
] as const;

it.each(cases)("recalls %s within the selected scope and hides identical other-project records", (query, text) => {
  const db = new MemoryRepository(":memory:");
  try {
    for (const [index, [, body]] of cases.entries()) db.save({ scope: "project:a", text: body, source: `source:${index}`, status: "active" });
    db.save({ scope: "project:b", text, source: "other", status: "active" });
    const result = db.list(["project:a"], query);
    expect(result.some(record => record.text === text)).toBe(true);
    expect(result.every(record => record.scope === "project:a")).toBe(true);
  } finally { db.close(); }
});
