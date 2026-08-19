#!/usr/bin/env node
/**
 * dsh-mem0-search — 主动搜索记忆命令（dsh-mem0-memory 三件套之一）
 *
 * 对 mem0-server /search 的 CLI 封装：像用搜索引擎一样查记忆库。
 * 支持 source 过滤（多源场景）、日期窗口、条数、降级模式标记展示。
 *
 * 用法：
 *   dsh-mem0-search "关键词"                    # 默认搜全部来源，top 5
 *   dsh-mem0-search "关键词" --limit 10         # 条数
 *   dsh-mem0-search "关键词" --source DSH       # 只搜指定来源
 *   dsh-mem0-search "关键词" --from 2026-08-01 --to 2026-08-19   # 日期窗口
 *   dsh-mem0-search "关键词" --json             # 原始 JSON 输出（脚本友好）
 *   dsh-mem0-search --server http://127.0.0.1:18200 "关键词"     # 自定义服务
 *
 * 输出：每条记忆一行（分数 + 来源 + 内容前 N 字）；degraded 时标注
 *       [降级=关键词模式]，topup 时标注 [含关键词补捞]。
 */

import { fileURLToPath } from "node:url";

const DEFAULT_SERVER = "http://127.0.0.1:18200";
const DEFAULT_LIMIT = 5;
// 日期窗口查询走 scroll+重排（慢路径，20-60s），超时要给足——普通查询远快于此
const TIMEOUT_MS = 60000;

function usage() {
  return `dsh-mem0-search — 主动搜索记忆（mem0-server /search 的 CLI 封装）

用法:
  dsh-mem0-search <关键词> [选项]

选项:
  --limit <N>          返回条数（默认 5）
  --source <src>       只搜指定来源（如 DSH；默认全部）
  --from <YYYY-MM-DD>  日期窗口起（含）
  --to <YYYY-MM-DD>    日期窗口止（含）
  --server <url>       mem0-server 地址（默认 ${DEFAULT_SERVER}）
  --json               输出原始 JSON（脚本友好，含 degraded/topup 标记）
  -h, --help           显示本帮助

示例:
  dsh-mem0-search "上次说的消息格式规范"
  dsh-mem0-search "项目技术栈" --source DSH --limit 10
  dsh-mem0-search "8月的决定" --from 2026-08-01 --to 2026-08-31 --json
`;
}

function parseArgs(argv) {
  const args = { query: "", limit: DEFAULT_LIMIT, source: undefined, from: undefined, to: undefined, server: DEFAULT_SERVER, json: false, help: false };
  const positional = [];
  const valueOpts = new Set(["--limit", "--source", "--from", "--to", "--server"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueOpts.has(a)) {
      const v = argv[i + 1];
      if (v !== undefined) {
        if (a === "--limit") args.limit = Number(v);
        else if (a === "--source") args.source = v;
        else if (a === "--from") args.from = v;
        else if (a === "--to") args.to = v;
        else if (a === "--server") args.server = v;
        i++; // 消费选项值，避免被当作位置参数
      }
    } else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (!a.startsWith("-")) positional.push(a);
  }
  args.query = positional.join(" ").trim();
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.query) {
    console.log(usage());
    return args.help ? 0 : 1;
  }

  const body = { query: args.query, limit: args.limit };
  if (args.source) body.source = args.source;
  if (args.from) body.date_from = args.from;   // 纯日期 YYYY-MM-DD（server 按 ts_day 前缀比较）
  if (args.to) body.date_to = args.to;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${args.server}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) {
      console.error(`搜索失败: ${data.error || `HTTP ${resp.status}`}`);
      return 1;
    }

    if (args.json) {
      console.log(JSON.stringify(data, null, 2));
      return 0;
    }

    const results = data.results || [];
    console.log(`「${args.query}」→ ${results.length} 条记忆` +
      (data.mode === "keyword" ? "（[降级] 关键词模式）" : "") +
      ((data.topup || 0) > 0 ? `（含关键词补捞 +${data.topup}）` : "") +
      `，耗时 ${data.elapsed_ms}ms`);
    for (const r of results) {
      const src = (r.metadata && r.metadata.source) ? `[${r.metadata.source}]` : "";
      const ts = (r.metadata && r.metadata.timestamp) ? r.metadata.timestamp.slice(0, 10) : "";
      console.log(`  ${String(r.score).slice(0, 5)} ${src} ${ts} ${String(r.memory || "").slice(0, 80)}`);
    }
    return 0;
  } catch (e) {
    console.error(`请求失败: ${e.name === "AbortError" ? "超时" : e.message}`);
    return 1;
  } finally {
    clearTimeout(timer);
  }
}

main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(e); process.exitCode = 1; });
