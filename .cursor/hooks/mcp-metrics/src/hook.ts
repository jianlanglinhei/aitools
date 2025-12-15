import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { diffLines } from "diff";

/**
 * Cursor Hooks 的 stdin payload 结构在不同版本可能略有差异：
 * - 通用字段：conversation_id, generation_id, hook_event_name, workspace_roots
 * - beforeMCPExecution：tool_name/tool_input/command 等
 * - afterFileEdit：file_path, edits[{old_string,new_string}]
 * - stop：status 等
 *
 * 本实现以“尽量宽容解析”为原则，不因字段缺失而报错阻塞。
 */

type HookBase = {
  conversation_id?: string;
  generation_id?: string;
  hook_event_name?: string;
  workspace_roots?: string[];
};

type BeforeMcp = HookBase & {
  // 这些字段不同环境可能出现其一
  server?: string;
  tool_name?: string;
  tool_input?: unknown; // 可能是 string，也可能已是 object
  command?: string;
  url?: string;
};

type AfterFileEdit = HookBase & {
  file_path?: string;
  edits?: Array<{ old_string: string; new_string: string }>;
};

type Stop = HookBase & {
  status?: "completed" | "aborted" | "error" | string;
};

type AnyHook = BeforeMcp | AfterFileEdit | Stop;

type LastMcp = {
  ts: number;
  server: string;
  tool_name: string;
  command?: string;
};

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function safeJsonParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function getWorkspaceRoot(input: AnyHook): string {
  const root = input.workspace_roots?.[0];
  return root && typeof root === "string" ? root : process.cwd();
}

function metricsDir(root: string) {
  return path.join(root, ".cursor", "mcp-metrics");
}

function statePath(root: string) {
  return path.join(metricsDir(root), "state.json");
}

function convoLogPath(root: string, conversationId: string) {
  return path.join(metricsDir(root), "conversations", `${conversationId}.jsonl`);
}

function summaryPath(root: string, conversationId: string, generationId: string) {
  return path.join(metricsDir(root), "summaries", conversationId, `${generationId}.json`);
}

function loadState(root: string): Record<string, LastMcp> {
  const p = statePath(root);
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, "utf8");
  return safeJsonParse<Record<string, LastMcp>>(raw) ?? {};
}

function saveState(root: string, s: Record<string, LastMcp>) {
  ensureDir(metricsDir(root));
  fs.writeFileSync(statePath(root), JSON.stringify(s, null, 2), "utf8");
}

function appendJsonl(p: string, obj: unknown) {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, JSON.stringify(obj) + "\n", "utf8");
}

function normalizeServer(input: BeforeMcp): string {
  // 优先 server；否则 fallback 到 command；再否则 unknown
  if (typeof input.server === "string" && input.server.trim()) return input.server.trim();
  if (typeof input.command === "string" && input.command.trim()) return input.command.trim();
  return "unknown";
}

function normalizeToolName(input: BeforeMcp): string {
  if (typeof input.tool_name === "string" && input.tool_name.trim()) return input.tool_name.trim();
  return "unknown_tool";
}

function countLines(s: string): number {
  if (!s) return 0;
  const parts = s.split("\n");
  // 让以换行结尾的文本不多算 1 行空行
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}

function lineDelta(oldStr: string, newStr: string): { added: number; removed: number } {
  const changes = diffLines(oldStr ?? "", newStr ?? "");
  let added = 0;
  let removed = 0;
  for (const c of changes) {
    const n = countLines(c.value);
    if ((c as any).added) added += n;
    if ((c as any).removed) removed += n;
  }
  return { added, removed };
}

function summarizeToolInput(tool_input: unknown): { kind: string; length?: number; keys?: string[] } {
  if (tool_input == null) return { kind: "null" };
  if (typeof tool_input === "string") return { kind: "string", length: tool_input.length };
  if (typeof tool_input === "object") {
    const keys = Object.keys(tool_input as Record<string, unknown>).slice(0, 20);
    return { kind: "object", keys };
  }
  return { kind: typeof tool_input };
}

async function main() {
  const raw = await readStdin();
  // stdin 可能为空；也可能不是 JSON
  const input = safeJsonParse<AnyHook>(raw) ?? ({} as AnyHook);

  const root = getWorkspaceRoot(input);
  const conversationId = input.conversation_id ?? "unknown_conversation";
  const generationId = input.generation_id ?? "unknown_generation";
  const event = input.hook_event_name ?? "unknown_event";

  const ts = Date.now();
  const logFile = convoLogPath(root, conversationId);
  const stateKey = `${conversationId}:${generationId}`;
  const state = loadState(root);

  if (event === "beforeMCPExecution") {
    const m = input as BeforeMcp;
    const server = normalizeServer(m);
    const toolName = normalizeToolName(m);

    // 为 afterFileEdit 的归因记录“最近一次 MCP”
    state[stateKey] = { ts, server, tool_name: toolName, command: m.command };
    saveState(root, state);

    appendJsonl(logFile, {
      ts,
      type: "beforeMCPExecution",
      conversation_id: conversationId,
      generation_id: generationId,
      server,
      tool_name: toolName,
      command: m.command ?? null,
      tool_input_summary: summarizeToolInput(m.tool_input)
    });

    return;
  }

  if (event === "afterFileEdit") {
    const a = input as AfterFileEdit;
    const filePath = a.file_path ?? "unknown_file";

    const last = state[stateKey];
    const attributed = last
      ? { server: last.server, tool_name: last.tool_name, ts: last.ts }
      : { server: "none", tool_name: "none", ts: null as number | null };

    let added = 0;
    let removed = 0;
    for (const e of a.edits ?? []) {
      const d = lineDelta(e.old_string ?? "", e.new_string ?? "");
      added += d.added;
      removed += d.removed;
    }

    appendJsonl(logFile, {
      ts,
      type: "afterFileEdit",
      conversation_id: conversationId,
      generation_id: generationId,
      file_path: filePath,
      attributed_server: attributed.server,
      attributed_tool: attributed.tool_name,
      attributed_mcp_ts: attributed.ts,
      lines_added: added,
      lines_removed: removed
    });

    return;
  }

  if (event === "stop") {
    const s = input as Stop;

    // 聚合当前 generation
    const mcpCounts = new Map<string, number>();
    const codeByMcp = new Map<string, { added: number; removed: number; edits: number }>();

    if (fs.existsSync(logFile)) {
      const lines = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        const ev = safeJsonParse<any>(line);
        if (!ev) continue;
        if (ev.generation_id !== generationId) continue;

        if (ev.type === "beforeMCPExecution") {
          const key = `${ev.server}::${ev.tool_name}`;
          mcpCounts.set(key, (mcpCounts.get(key) ?? 0) + 1);
        }

        if (ev.type === "afterFileEdit") {
          const key = `${ev.attributed_server}::${ev.attributed_tool}`;
          const cur = codeByMcp.get(key) ?? { added: 0, removed: 0, edits: 0 };
          cur.added += Number(ev.lines_added ?? 0);
          cur.removed += Number(ev.lines_removed ?? 0);
          cur.edits += 1;
          codeByMcp.set(key, cur);
        }
      }
    }

    const summary = {
      ts,
      conversation_id: conversationId,
      generation_id: generationId,
      status: s.status ?? "unknown",
      mcp_tools: Array.from(mcpCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([k, count]) => {
          const [server, tool_name] = k.split("::");
          return { server, tool_name, count };
        }),
      code_by_mcp: Array.from(codeByMcp.entries())
        .sort((a, b) => (b[1].added + b[1].removed) - (a[1].added + a[1].removed))
        .map(([k, v]) => {
          const [server, tool_name] = k.split("::");
          return {
            server,
            tool_name,
            lines_added: v.added,
            lines_removed: v.removed,
            edit_events: v.edits
          };
        })
    };

    const out = summaryPath(root, conversationId, generationId);
    ensureDir(path.dirname(out));
    fs.writeFileSync(out, JSON.stringify(summary, null, 2), "utf8");

    // 在 hooks 输出里打印简报（不影响主流程）
    console.error(`[mcp-metrics] summary: ${path.relative(root, out)}`);
    console.error(
      `[mcp-metrics] tools=${summary.mcp_tools.length}, attribution_buckets=${summary.code_by_mcp.length}`
    );

    // 清理本 generation 的 last MCP 状态，避免污染下一次
    delete state[stateKey];
    saveState(root, state);

    return;
  }

  // 其它事件忽略
}

main().catch((e) => {
  // hook 失败不应阻塞 Cursor/Agent 流程
  console.error(`[mcp-metrics] hook error: ${(e as Error)?.message ?? String(e)}`);
  process.exit(0);
});
