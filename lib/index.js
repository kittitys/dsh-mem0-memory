/**
 * dsh-mem0-memory — DSH 薄桥插件
 *
 * 监听 `agent/pre-step`，取进入步骤的最后一条真实 user 消息作查询，
 * 调 mem0-server（127.0.0.1:18200 /search）召回相关记忆，
 * 把 <relevant-memories> 块注入到步骤消息批次（在 claimed 消息之后插入），
 * 等效 OpenClaw mem0-memory 插件的 before_prompt_build + appendSystemContext。
 *
 * 后处理移植自 OpenClaw 侧 recall.js（🔵 已读源码）：
 *   - 词法重叠 boost（≤0.2）
 *   - 精确去重 + 中文 bigram Jaccard 语义去重（阈值 0.4）
 *   - scoreThreshold 过滤（默认 0.15）+ limit（默认 5）+ tokenBudget（默认 2000）
 *
 * 设计原则（主文档 §3.3）：**薄**——单次 HTTP + 纯 JS 后处理，不做多轮 agent 循环。
 * （OpenClaw active-memory 死于过度设计，mem0-memory 活是因为简单直接。）
 *
 * 配置（profile cordis.patch.yml 覆盖）：
 *   - id: mem0-memory
 *     config:
 *       serverUrl: http://127.0.0.1:18200
 *       enabled: true
 *       limit: 5            # 注入条数上限
 *       scoreThreshold: 0.15
 *       tokenBudget: 2000
 *       source: DSH         # 可选：仅召回指定 source（G4）
 *       probePath: ""       # 可选：排障探针日志文件路径（默认空=关闭；设置后才写文件）
 *       autoImport: true    # 会话结束自动增量导入（默认开；关 = 手动 dsh-mem0-import）
 */

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));

const MEM0_SERVER = "http://127.0.0.1:18200";
// 召回超时对齐 OpenClaw mem0-memory 插件（index.js timeoutMs: 20000）。
// 实测 mem0 /search 冷/热态 5-10s（embedding 走 SiliconFlow），5s 必超时。
const MEM0_SEARCH_TIMEOUT_MS = 20000;
const MAX_BLOCK_CHARS = 8000;          // 注入块字符上限（约 tokenBudget*4 的保险）

// ─── 后处理（移植 OpenClaw recall.js）────────────────────────────────────
const RECALL_STOPWORDS = new Set([
  "what", "when", "where", "which", "who", "whom", "whose", "why", "how",
  "did", "does", "is", "are", "was", "were", "the", "and", "for", "with",
  "from", "that", "this", "your", "you",
]);
const RECALL_TOKEN_RE = /[a-z0-9\u4e00-\u9fa5]{2,}/gi;

function buildQueryProfile(queryText) {
  const text = String(queryText || "").trim();
  const allTokens = text.toLowerCase().match(RECALL_TOKEN_RE) ?? [];
  return { tokens: allTokens.filter((t) => !RECALL_STOPWORDS.has(t)) };
}

function lexicalOverlapBoost(tokens, text) {
  if (tokens.length === 0 || !text) return 0;
  const haystack = ` ${text.toLowerCase()} `;
  let matched = 0;
  for (const token of tokens.slice(0, 8)) {
    if (haystack.includes(` ${token} `) || haystack.includes(token)) matched += 1;
  }
  return Math.min(0.2, (matched / Math.min(tokens.length, 4)) * 0.2);
}

function extractContentWords(text) {
  const normalized = String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, " ").trim();
  const words = normalized.split(/\s+/).filter((w) => w.length >= 2);
  const ngrams = new Set();
  for (const word of words) {
    if (/[\p{Script=Han}]/u.test(word)) {
      for (let i = 0; i < word.length - 1; i++) ngrams.add(word.slice(i, i + 2));
    } else {
      ngrams.add(word);
    }
  }
  return ngrams;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function semanticDedup(items, threshold = 0.4) {
  const result = [];
  const sets = items.map((i) => extractContentWords(i.memory ?? ""));
  for (let i = 0; i < items.length; i++) {
    let dup = false;
    for (const kept of result) {
      const idx = items.indexOf(kept);
      if (jaccard(sets[i], sets[idx]) >= threshold) { dup = true; break; }
    }
    if (!dup) result.push(items[i]);
  }
  return result;
}

function pickMemories(items, query, limit, scoreThreshold) {
  const profile = buildQueryProfile(query);
  const sorted = [...items].sort((a, b) => {
    const sa = (a.score ?? 0) + lexicalOverlapBoost(profile.tokens, a.memory ?? "");
    const sb = (b.score ?? 0) + lexicalOverlapBoost(profile.tokens, b.memory ?? "");
    return sb - sa;
  });
  const seen = new Set();
  const deduped = [];
  for (const item of sorted) {
    const key = `memory:${String(item.memory ?? "").toLowerCase().replace(/\s+/g, " ").slice(0, 200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return semanticDedup(deduped)
    .filter((item) => (item.score ?? 0) >= scoreThreshold)
    .slice(0, limit);
}

function formatBlock(items) {
  if (items.length === 0) return "";
  const lines = [
    "[MEM0-RECALL]",
    "<relevant-memories>",
    "以下是从 Mem0 长期记忆中召回的相关记忆，优先参考这些内容回答用户问题。",
  ];
  let used = 0;
  for (const item of items) {
    const content = String(item.memory ?? "").trim();
    if (!content) continue;
    const entry = `<memory id="${item.id}">\n${content}\n</memory>`;
    if (used + entry.length + 1 > MAX_BLOCK_CHARS) break;
    lines.push(entry);
    used += entry.length + 1;
  }
  if (lines.length <= 3) return "";
  lines.push("</relevant-memories>");
  return lines.join("\n");
}

// ─── 召回（单次 HTTP，薄）────────────────────────────────────────────────
async function recallMemories(config, query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? MEM0_SEARCH_TIMEOUT_MS);
  try {
    const body = { query, limit: 20 };
    if (config.source) body.source = config.source;   // G4: 按来源过滤
    const resp = await fetch(`${config.serverUrl ?? MEM0_SERVER}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const data = await resp.json();
    if (!data.ok) return { ok: false, error: data.error || "search failed" };
    const picked = pickMemories(data.results ?? [], query, config.limit ?? 5, config.scoreThreshold ?? 0.15);
    const block = formatBlock(picked);
    return { ok: true, block, count: picked.length, results: picked };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// ─── 消息提取（取最后一条真实 user 消息）─────────────────────────────────
function flattenMessageContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (typeof b === "string") return b;
      if (b && typeof b === "object") {
        if (typeof b.text === "string") return b.text;
        if (typeof b.content === "string") return b.content;
      }
      return "";
    }).join("");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
  }
  return "";
}

function extractLastUserText(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;
    const text = flattenMessageContent(msg.content).trim();
    if (text && !text.includes("<relevant-memories>")) return text;
  }
  return null;
}

// ─── 插件入口 ────────────────────────────────────────────────────────────
export const name = "dsh-mem0-memory";
export const inject = ["agents"];

export async function apply(ctx, config = {}) {
  // 探针（排障用，默认关闭）：设置 config.probePath 后，apply 执行即写文件——
  // 用于区分「插件未加载」vs「加载了但 pre-step 未触发」。默认不写任何文件。
  const probePath = config.probePath ? path.resolve(String(config.probePath)) : "";
  const probe = async (msg) => {
    if (!probePath) return;
    try {
      const fs = await import("node:fs");
      fs.appendFileSync(probePath, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
    } catch (e) {}
  };
  await probe(`apply() executed, config=${JSON.stringify(config)}`);

  const cfg = {
    enabled: config.enabled !== false,
    serverUrl: config.serverUrl ?? MEM0_SERVER,
    limit: config.limit ?? 5,
    scoreThreshold: config.scoreThreshold ?? 0.15,
    tokenBudget: config.tokenBudget ?? 2000,
    timeoutMs: config.timeoutMs ?? MEM0_SEARCH_TIMEOUT_MS,
    source: config.source,   // 可选
    autoImport: config.autoImport !== false,  // 会话结束自动增量导入（默认开，三档机制①）
  };
  if (!cfg.enabled) {
    ctx.logger?.info("[mem0-memory] disabled");
    return;
  }

  // ─── 会话结束自动增量导入（P2.4：session/disposed 钩子）───────────────
  // fire-and-forget：不阻塞 dispose；子进程间有 .import.lock 互斥（并发安全）。
  // import 脚本定位：插件包内 bin/dsh-mem0-import.mjs（无需用户配置路径）。
  if (cfg.autoImport) {
    const importCmd = path.join(PKG_DIR, "bin", "dsh-mem0-import.mjs");
    ctx.on("session/disposed", (session) => {
      const sessionId = session?.id ?? session?.sessionId ?? "";
      probe(`session/disposed fired: ${sessionId}`);
      spawn(process.execPath, [importCmd, "--since-last"], {
        stdio: "ignore",
        detached: false,
      }).on("error", (e) => {
        ctx.logger?.warn(`[mem0-memory] auto-import spawn failed: ${e.message}`);
      });
      ctx.logger?.info(`[mem0-memory] auto-import triggered (session ${sessionId || "?"})`);
    });
    ctx.logger?.info("[mem0-memory] auto-import armed (session/disposed)");
  }

  ctx.on("agent/pre-step", async ({ messages, signal }, next) => {
    // 探针（排障用）：pre-step 触发即写文件
    await probe(`pre-step fired, messages=${Array.isArray(messages) ? messages.length : "?"}, roles=${Array.isArray(messages) ? messages.map(m => m.role).join(",") : "?"}`);

    // 先让下游决定本步骤的消息批次
    const decision = await next();
    await probe(`decision kind=${decision.kind}, decision.messages=${Array.isArray(decision.messages) ? decision.messages.length : "?"}`);

    if (decision.kind !== "enter" || !Array.isArray(decision.messages)) return decision;

    try {
      const query = extractLastUserText(decision.messages);
      await probe(`query extracted: ${query ? query.slice(0, 80) : "NULL"}`);
      if (!query) return decision;

      const result = await recallMemories(cfg, query);
      await probe(`recall result: ok=${result.ok}, count=${result.count ?? "?"}, block=${(result.block || "").length}chars, error=${result.error || "none"}`);
      if (!result.ok || !result.block) {
        ctx.logger?.info(`[mem0-memory] recall skip: ${result.error || "no block"} (query="${query.slice(0, 60)}")`);
        return decision;
      }

      ctx.logger?.info(`[mem0-memory] recall ${result.count} memories (${result.block.length} chars)`);

      // 注入：在最后一条 claimed 消息之后插入记忆块。
      // 必须带消息 id 且 content 用文本块数组 —— DSH 的 user/message 事件校验要求
      // message.id 为非空字符串、content 为块数组，缺失会把整个 session 持久化日志判为损坏。
      const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message));
      await probe(`lastClaimedIndex=${lastClaimedIndex}`);
      const injected = {
        role: "user",
        id: randomUUID(),
        content: [{ type: "text", text: result.block }],
        source: { kind: "plugin", plugin: "dsh-mem0-memory", form: "recall" },
      };
      const finalMessages = decision.messages.toSpliced(lastClaimedIndex + 1, 0, injected);
      await probe(`injected! finalMessages=${finalMessages.length}`);
      return {
        kind: "enter",
        messages: finalMessages,
      };
    } catch (e) {
      await probe(`EXCEPTION: ${e.message}`);
      // 绝不让记忆召回破坏步骤（退化：不注入）
      ctx.logger?.warn(`[mem0-memory] recall failed: ${e.message}`);
      return decision;
    }
  });
}
