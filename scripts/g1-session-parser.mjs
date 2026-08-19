#!/usr/bin/env node
/**
 * g1-session-parser.mjs — DSH 会话日志 → mem0 记忆批次解析器
 *
 * 【定位】
 *   DSH session（原始日志）→ G1 解析器 → 增量窗口 → mem0（唯一事实源）。
 *   本脚本是 G1 解析器主实现，负责把 DSH 的对话日志翻译成记忆批次。
 *
 * 【输入】  ~/.dsh/sessions/<projectKey>/<sessionId>/session.jsonl.zstd
 *          （zstd 帧容器：header 帧 + append 帧；事件 JSONL）
 * 【输出】  与 mem0 对话批次同构的数组 batch：
 *          <out>/<YYYY-MM-DD>/P0_NNN.json
 *          （[{role:"user"|"assistant", content:"[时间 渠道] 内容"}, ...]）
 *
 * 【session 选择规则】Level 0 硬过滤：
 *     - 文件 size === 0 → 跳过（空壳 session，无帧可解）
 *     - delegationDepth >= 1 → 跳过（子代理 session；报告已 relay 进主 session，
 *       无信息增量。--include-subagents 可放宽）
 *     - 无真实 user/message 的 session → 跳过（纯机械/系统 session 无记忆价值，
 *       对齐 isSyntheticSession 哲学。--include-empty 可放宽）
 *     - 排除工作区：独立工作区（如金融/个人专区）不得进入记忆库，防止污染
 *       跨会话记忆。规则：①**前缀约定（写死）**——工作区目录名以 `0_` 开头 =
 *       不入库（未来新建工作区按此命名，零维护）；②excluded-workspaces.json
 *       名单（仅历史遗留区）；配置缺失/损坏 → fail-closed 退出（拒绝无保护运行）
 *
 * 【消息提取规则】（核心：对齐回合级语义）
 *   - 按「真实 user/message」锚点分组（一个 user 及其后的所有 assistant 为一组）
 *   - 每组只保留最后一条 assistant/message（= 最终交付回复，含整个 turn 的
 *     完整总结；中间消息是思考/工作过程，易产冗余 fact——实测 89% 为中间噪音）
 *   - 无 user 配对的 assistant 消息丢弃
 *   - source.kind 注入过滤（非真实用户输入）：agent-instructions / skill-catalog /
 *     plugin / subagent-settled / subagent-report / goal / system / hook / compaction
 *   - 内容噪音过滤 + 凭据模式过滤
 *
 * 【增量窗口】
 *   --since-seq N：只处理 seq > N 的事件（真增量 checkpoint）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

// ─── 配置 ────────────────────────────────────────────────────────────────
// 路径全部可经环境变量/CLI 覆盖，默认落在 $DSH_HOME 下：
//   DSH_HOME         DSH 数据根目录（默认 ~/.dsh）
//   --out <dir>      批次输出目录（默认 $DSH_HOME/tmp/dsh-memory-g1）
//   --log-dir <dir>  日志目录（默认 $DSH_HOME/logs）
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const SESSIONS_ROOT = path.join(DSH_HOME, "sessions");
const OUT_ROOT = path.join(DSH_HOME, "tmp", "dsh-memory-g1");
const MAX_CONTENT_CHARS = 10000;      // 与 mem0 MAX_CHARS 对齐
const MAX_MSGS_PER_BATCH = 60;        // 与 mem0 MAX_MSGS 对齐
const DEFAULT_LOG_DIR = path.join(DSH_HOME, "logs");

// ─── 工作区排除（无关工作区不得污染记忆库）──────────────────────────────
// 【背景】G1 遍历 $DSH_HOME/sessions/ 下所有 projectKey（= 一个工作区）。
//   独立 KM 工作区（金融/个人专区等）不得进入记忆库。
// 【规则】未来新建工作区：不入库的 → 目录名加前缀 `0_`（工作区名称 = 目录名
//   basename，源码实证 dsh-workspace）。前缀命中 = 写死约定，无需任何配置；
//   非 `0_` 前缀的工作区一律入库。
// 【配置】excluded-workspaces.json 的 excluded 数组（仅历史遗留区——名称无
//   前缀但必须排除）；每条按子串匹配「解码后的工作区路径」或「原始
//   projectKey」，任一命中即整体排除该工作区。
// 【安全】配置文件缺失/损坏 → 抛错退出（fail-closed：宁可今天不跑，
//   也不可无保护地把无关工作区灌进记忆库）。
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXCLUDED_WORKSPACES_FILE = path.join(SCRIPT_DIR, "excluded-workspaces.json");
/** 不入库的工作区命名前缀（写死约定：未来新建不入库的工作区以此命名） */
const EXCLUDE_PREFIX = "0_";

function loadExcludedWorkspaces() {
  if (!fs.existsSync(EXCLUDED_WORKSPACES_FILE)) {
    throw new Error(`工作区排除配置文件缺失: ${EXCLUDED_WORKSPACES_FILE}（fail-closed，拒绝无保护运行）`);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(EXCLUDED_WORKSPACES_FILE, "utf8"));
  } catch (e) {
    throw new Error(`工作区排除配置文件解析失败: ${EXCLUDED_WORKSPACES_FILE} — ${e.message}`);
  }
  const list = cfg && Array.isArray(cfg.excluded) ? cfg.excluded : null;
  if (!list) throw new Error(`工作区排除配置缺少 excluded 数组: ${EXCLUDED_WORKSPACES_FILE}`);
  return list.map((s) => String(s).trim()).filter(Boolean);
}

/** projectKey → 可读路径（实测编码 2026-08-19：路径段以 '-' 连接；段内非 ASCII
 *  字符转义为连续 ~XXXX，XXXX = UTF-16BE hex，如 中=~4E2D 文=~6587 对=~5BF9
 *  话=~8BDD，一个目录名「中文对话」= 一整段 ~4E2D~6587~5BF9~8BDD，
 *  此例亦说明中文工作区名的编码形态）。
 *  注意：目录名本身含 '-' 时解码有歧义（如 DSH-ws1 → DSH\ws1），仅作可读
 *  参考与子串匹配用，不作为唯一依据（原始 projectKey 同时参与匹配）。 */
function decodeProjectKey(key) {
  const decoded = String(key).replace(/~([0-9A-Fa-f]{4})/g, (m, hex) => {
    try { return String.fromCharCode(parseInt(hex, 16)); } catch { return m; }
  });
  return decoded.split("-").filter(Boolean).join("\\");
}

function isWorkspaceExcluded(projectKey, decoded, excluded) {
  return excluded.some((e) => projectKey.includes(e) || decoded.includes(e));
}

/** 前缀规则（写死约定）：不入库的工作区 = 名称以 `0_` 开头。名称有两处
 *  载体：①目录名（= 创建时的默认 title，路径派生 projectKey）；②台账标题
 *  （~/.dsh/storages/workspace.json 的 title，UI 可改名，不影响磁盘目录）。
 *  三个命中渠道：解码路径任一段 / 原始 projectKey 任一段 / 台账标题，
 *  任一命中即排除。
 *  @returns 命中渠道数组（空数组 = 未命中） */
function prefixedChannels(projectKey, decoded, record) {
  const ch = [];
  if (decoded.split("\\").some((s) => s.startsWith(EXCLUDE_PREFIX))) ch.push("前缀0_(路径)");
  if (projectKey.split("-").some((s) => s.startsWith(EXCLUDE_PREFIX))) ch.push("前缀0_(projectKey)");
  if (record && String(record.title).startsWith(EXCLUDE_PREFIX)) ch.push("前缀0_(标题)");
  return ch;
}

function isPrefixedWorkspace(projectKey, decoded, record) {
  return prefixedChannels(projectKey, decoded, record).length > 0;
}

// ─── DSH 工作区台账（名称的权威载体）─────────────────────────────────────
// workspace.json 是 DSH 全局台账：path + title + sessionIds。projectKey 由
// 路径派生，但 UI 可改 title（不动目录）——前缀规则必须同时看 title。
// 台账读取失败仅 WARN 降级（标题通道是补充；主闸门 excluded-workspaces.json
// 仍是 fail-closed 硬闸门）。
let _workspaceRegistry = null;

function normalizeWsPath(p) {
  return String(p).replace(/\\+$/, "").toLowerCase();
}

function loadWorkspaceRegistry() {
  if (_workspaceRegistry) return _workspaceRegistry;
  _workspaceRegistry = new Map(); // 规范化路径(小写) -> { path, title }
  try {
    const file = path.join(DSH_HOME, "storages", "workspace.json");
    if (!fs.existsSync(file)) return _workspaceRegistry;
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    const tables = cfg && cfg.tables && cfg.tables.workspaces ? cfg.tables.workspaces : {};
    for (const rec of Object.values(tables)) {
      if (rec && typeof rec.path === "string" && typeof rec.title === "string") {
        _workspaceRegistry.set(normalizeWsPath(rec.path), rec);
      }
    }
  } catch (e) {
    log("WARN", "registry", `工作区台账读取失败（前缀0_标题通道降级）: ${e.message}`);
  }
  return _workspaceRegistry;
}

/** 由解码后的工作区路径查台账记录；basename 兜底（路径大小写/尾斜杠差异） */
function registryRecordFor(decoded) {
  const rec = loadWorkspaceRegistry().get(normalizeWsPath(decoded));
  if (rec) return rec;
  const last = decoded.split("\\").filter(Boolean).pop();
  if (!last) return null;
  const lc = last.toLowerCase();
  for (const r of loadWorkspaceRegistry().values()) {
    const rLast = r.path.split("\\").filter(Boolean).pop();
    if (rLast && rLast.toLowerCase() === lc) return r;
  }
  return null;
}

// ─── Logger（复杂管线工程守则：必须有足够追查问题根因的 log）─────────────
// 统一日志：时间戳 + 级别 + 环节 + 明细；stdout 实时 + --log-file 落盘（默认 mem0-daily-logs/g1-<date>.log）
// 级别：INFO（正常流程）/ WARN（可恢复异常）/ ERROR（失败，含堆栈）
let _logFile = null;
let _logFd = null;

function initLogger(dateStr, logDir) {
  try {
    const dir = logDir || DEFAULT_LOG_DIR;
    fs.mkdirSync(dir, { recursive: true });
    _logFile = path.join(dir, `g1-${dateStr || "unknown"}.log`);
    _logFd = fs.openSync(_logFile, "a");
    log("INFO", "init", `日志文件: ${_logFile}`);
  } catch (e) {
    console.error(`[g1] 无法初始化日志文件: ${e.message}`);
  }
}

function closeLogger() {
  try { if (_logFd !== undefined) fs.closeSync(_logFd); } catch {}
  _logFd = undefined;
}

function log(level, phase, msg, extra) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] [${phase}] ${msg}`;
  console.log(line);
  if (_logFd !== undefined) {
    try { fs.writeSync(_logFd, line + "\n"); } catch {}
  }
  if (extra !== undefined) {
    const extraLine = `[${ts}] [${level}] [${phase}]   └─ ${String(extra).slice(0, 2000)}`;
    console.log(extraLine);
    if (_logFd !== undefined) {
      try { fs.writeSync(_logFd, extraLine + "\n"); } catch {}
    }
  }
}

// ─── 续号 + staging（补跑/双源共存支持）───────────────────────────────────
// 目标目录已有 P0_*.json 时，从最大编号 +1 续写（不覆盖已有 batch）。
// 输出先写 staging 目录（<out>-staging），自校验通过后才拷贝到正式目录
// （不污染，失败可重来）。
function stagingRootFor(out) {
  return `${out}-staging`;
}

/** 扫描目录已有 P0_*.json 的最大编号，返回 N+1（无则 1）。不存在目录返回 1。 */
function nextP0Number(dateDir) {
  try {
    if (!fs.existsSync(dateDir)) return 1;
    const files = fs.readdirSync(dateDir).filter((f) => /^P0_\d{3}\.json$/.test(f));
    if (files.length === 0) return 1;
    const maxN = Math.max(...files.map((f) => parseInt(f.slice(3, 6), 10)));
    return maxN + 1;
  } catch (e) {
    log("WARN", "nextP0Number", `扫描目录失败，从 1 开始: ${e.message}`);
    return 1;
  }
}

// 渠道映射（按 session 目录名推断渠道名）
const CHANNEL_MAP = [
  [/lark-link/i, "飞书"],
  [/wechat|wx-/i, "微信"],
  [/webchat|dash|session-/i, "WebChat"],
];

// ─── zstd 帧扫描（移植自 dsh-session-persistence-jsonl，🔵 已验证）──────
const ZSTD_MAGIC = 4247762216; // 0xFD2FB528

function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, ok: false };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) return { frames, ok: false };
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, ok: false };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, ok: false };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames, ok: true };
}

function decodeSessionLog(file) {
  const buf = fs.readFileSync(file);
  if (buf.length === 0) return { text: "", empty: true };
  const { frames, ok } = scanZstdFrames(buf);
  if (!ok) {
    console.warn(`  [warn] 帧扫描尾部不完整（可能未落盘末帧），使用 ${frames.length} 个完整帧`);
  }
  const chunks = [];
  for (const frame of frames) {
    try {
      chunks.push(zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString("utf8"));
    } catch (e) {
      console.warn(`  [warn] 帧 ${frame.start}..${frame.end} 解码失败：${e.message}`);
    }
  }
  return { text: chunks.join(""), empty: false };
}

// ─── 事件解析 ────────────────────────────────────────────────────────────
function parseEvents(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === "object" && typeof obj.type === "string") {
        events.push(obj);
      } else if (obj && typeof obj === "object" && obj.event && typeof obj.event.type === "string") {
        events.push(obj.event);
      }
    } catch { /* 非 JSON 行跳过 */ }
  }
  events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return events;
}

// ─── session header 读取（depth/origin 判断）─────────────────────────────
function readSessionHeader(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length === 0) return { empty: true };
    const { frames } = scanZstdFrames(buf);
    if (frames.length === 0) return { empty: true };
    const headerText = zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString("utf8");
    const firstLine = headerText.split("\n")[0];
    const o = JSON.parse(firstLine);
    const h = o.header || o;
    return {
      id: String(h.id || ""),
      delegationDepth: typeof h.delegationDepth === "number" ? h.delegationDepth : 0,
      origin: h.origin,
      parentSession: h.parentSession,
      empty: false,
    };
  } catch {
    return { empty: true };
  }
}

// ─── 文本提取 ────────────────────────────────────────────────────────────
function flattenText(content) {
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

// ─── Level 1 清洗：内容噪音（命令执行/系统输出噪音过滤）──────────────────
function isGarbageContent(c) {
  if (!c) return true;
  if (/^\s*(?:stages|core-plugin-tool|abort-wrappers|deferred-followup|attempt:|openclaw\.|node\.list|ws\s+[⬅➡↔⇄])/i.test(c)) return true;
  if (/^An async command (?:did not run|the user already approved has completed)/i.test(c)) return true;
  if (/^Exec finished \(gateway id=/i.test(c)) return true;
  if (/^Approval required \(id /i.test(c)) return true;
  if (/^Exact completion details:/i.test(c)) return true;
  if (/^Command:\s*```/i.test(c)) return true;
  if (/^Mode: foreground/i.test(c)) return true;
  if (/^Conversation info \(untrusted metadata\):/i.test(c)) return true;
  if (/request:\s*Writable\s*\{\s*_events:\s*\[Object\]/i.test(c)) return true;
  if (/abort-wrappers:\d+ms@\d+ms|deferred-followup-descriptions:\d+ms@\d+ms|attempt:[a-z0-9-]+:\d+ms@\d+ms/i.test(c)) return true;
  if (c.length > 400 && /^[\x00-\x7F\s]+$/.test(c)) {
    const lower = c.toLowerCase();
    let score = 0;
    if (lower.includes("approval required")) score += 3;
    if (lower.includes("gateway id=")) score += 2;
    if (lower.includes("exact completion details")) score += 3;
    if (lower.includes("async command")) score += 2;
    if (lower.includes("exec finished")) score += 2;
    if (lower.includes("only ask the user")) score += 1;
    if (lower.includes("do not run the command again")) score += 2;
    if (score >= 3) return true;
  }
  return false;
}

// ─── Level 1 清洗：凭据模式（secret-scanner 思路）────────────────────────
const SECRET_PATTERNS = [
  /\b(?:sk|pk|ak|token|secret|api[_-]?key|password|passwd|pwd)\b[=:]\s*['"]?[A-Za-z0-9_\-]{12,}/i,
  /\b(?:sk-|pk-)[A-Za-z0-9]{20,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
];

function hasSecret(c) {
  return SECRET_PATTERNS.some((re) => re.test(c));
}

// ─── 消息提取（核心：user 锚点分组 + 每 turn 取最后一条 assistant）───────
const INJECTION_KINDS = new Set([
  "plugin", "system", "goal", "agent-instructions", "skill-catalog",
  "subagent-settled", "subagent-report", "hook", "compaction",
]);

function isRealUserEvent(ev) {
  if (ev.type !== "user/message") return false;
  const kind = ev.data?.source?.kind;
  if (kind === undefined) return true; // 无 source 视为真实用户（兼容旧格式）
  return !INJECTION_KINDS.has(kind);
}

/**
 * 提取对话消息：
 *  - 按真实 user/message 锚点分组
 *  - 每组只保留最后一条 assistant/message（最终交付回复）
 *  - 无 user 配对的 assistant 丢弃
 */
function extractMessages(events, sinceSeq) {
  const pairs = [];       // [{user, assistant, userSeq}]
  let cur = null;         // 当前分组
  const dropped = { plugin: 0, garbage: 0, secret: 0, empty: 0, orphan: 0, total: 0 };

  for (const ev of events) {
    if (sinceSeq !== undefined && (ev.seq ?? 0) <= sinceSeq) continue;
    dropped.total++;

    if (ev.type === "user/message") {
      if (!isRealUserEvent(ev)) { dropped.plugin++; continue; }
      // 结算上一组
      if (cur !== null) pairs.push(cur);
      const text = flattenText(ev.data?.content).trim();
      cur = {
        user: { role: "user", content: text, seq: ev.seq, ts: ev.data?.timestamp || ev.time },
        assistant: null,
      };
      if (!text || text.length < 2) {
        // 空 user 消息：不成立组（也计入 empty）
        dropped.empty++;
        cur = null;
      }
    } else if (ev.type === "assistant/message") {
      if (cur === null) { dropped.orphan++; continue; } // 无 user 配对的 assistant
      const text = flattenText(ev.data?.message?.content).trim();
      if (!text) { dropped.empty++; continue; }
      if (isGarbageContent(text)) { dropped.garbage++; continue; }
      if (hasSecret(text)) { dropped.secret++; continue; }
      // 只保留最后一条（覆盖式）
      cur.assistant = {
        role: "assistant",
        content: text.length > MAX_CONTENT_CHARS ? text.slice(0, MAX_CONTENT_CHARS) + "…[truncated]" : text,
        seq: ev.seq,
        ts: ev.data?.message?.timestamp || ev.time,
      };
    }
    // 其他事件（tool/边界/chunk）不参与
  }
  if (cur !== null) pairs.push(cur);

  // 输出：user + 最后一条 assistant（无 assistant 的组也保留 user 单条）
  const msgs = [];
  for (const p of pairs) {
    if (p.user) msgs.push(p.user);
    if (p.assistant) msgs.push(p.assistant);
  }
  return { msgs, dropped, userTurns: pairs.length };
}

// ─── 时间/渠道处理 ───────────────────────────────────────────────────────
function toDateStr(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toTimeStr(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function channelForDir(dir) {
  for (const [re, ch] of CHANNEL_MAP) {
    if (re.test(dir)) return ch;
  }
  return "";
}

// ─── batch 组装（与 mem0-build-prebatches 同构）──────────────────────────
function buildBatches(msgs) {
  const batches = [];
  let cur = [], curChars = 0;
  for (const m of msgs) {
    if ((curChars + m.content.length > MAX_CONTENT_CHARS && cur.length > 0) || cur.length >= MAX_MSGS_PER_BATCH) {
      batches.push(cur.slice());
      cur = [];
      curChars = 0;
    }
    cur.push(m);
    curChars += m.content.length;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

// ─── 主流程 ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    session: get("--session"),
    sinceSeq: get("--since-seq"),
    date: get("--date"),
    dryRun: argv.includes("--dry-run"),
    out: get("--out") ?? OUT_ROOT,
    includeSubagents: argv.includes("--include-subagents"),
    includeEmpty: argv.includes("--include-empty"),
    logDir: get("--log-dir"),
    checkpoint: get("--checkpoint"),
    resultFile: get("--result-file"),
  };
}

// ─── checkpoint / result（P2.1：per-session 增量窗口 + 崩溃容忍）──────────
// checkpoint：`{sessionId: lastSeq}`（每个 session 上次导入到的最大事件 seq）。
// G1 只**读** checkpoint 做增量窗口、只**写** result 文件（候选结果）——
// 正式 checkpoint 由调用方（dsh-mem0-import）在导入全部成功后才落盘，
// 保证「失败不更新 checkpoint」。result 写入用 tmp+rename 原子替换。

function loadCheckpoint(file) {
  try {
    if (!fs.existsSync(file)) {
      log("INFO", "checkpoint", `checkpoint 不存在（全量模式）: ${file}`);
      return {};
    }
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("结构非法");
    const map = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) map[k] = v;
    }
    log("INFO", "checkpoint", `checkpoint 已加载: ${Object.keys(map).length} 个 session`);
    return map;
  } catch (e) {
    log("WARN", "checkpoint", `checkpoint 读取失败（按全量处理，mem0 hash 去重兜底）: ${e.message}`);
    return {};
  }
}

function writeResultFile(file, lastSeqMap, batches) {
  if (!file) return;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ lastSeq: lastSeqMap, batches }, null, 2), "utf8");
  // 写后校验（崩溃容忍：读回可解析才 rename，避免半截文件成为正式 checkpoint）
  const parsed = JSON.parse(fs.readFileSync(tmp, "utf8"));
  if (!parsed || typeof parsed.lastSeq !== "object" || !Array.isArray(parsed.batches)) {
    throw new Error("result 自校验失败");
  }
  fs.renameSync(tmp, file);
  log("INFO", "checkpoint", `result 已写入: ${file}（${Object.keys(lastSeqMap).length} session / ${batches.length} batch）`);
}

const USAGE = `g1-session-parser — DSH 会话日志 → mem0 记忆批次解析器（P0 对话导入）

用法:
  node g1-session-parser.mjs [选项]

选项:
  --session <file>     只解析指定 session 文件（默认扫描 $DSH_HOME/sessions）
  --since-seq <N>      增量：只处理 seq > N 的事件（全局阈值；与 --checkpoint 互斥）
  --checkpoint <file>  per-session 增量：读 \`\{sessionId: lastSeq}\` 作各自窗口（推荐）
  --result-file <file> 写本次结果 \`\{lastSeq: \{sessionId: N}, batches: [...]}\`（原子写，
                       供导入命令在全部成功后落盘为正式 checkpoint；失败不更新）
  --date <YYYY-MM-DD>  只输出指定日期的批次（默认今天）
  --out <dir>          批次输出目录（默认 $DSH_HOME/tmp/dsh-memory-g1）
  --log-dir <dir>      日志目录（默认 $DSH_HOME/logs）
  --include-subagents  放宽：收录子代理 session（默认跳过）
  --include-empty      放宽：收录无真实 user 的 session（默认跳过）
  --dry-run            只统计不落盘
  -h, --help           显示本帮助

环境变量:
  DSH_HOME             DSH 数据根目录（默认 ~/.dsh）

工作区排除:
  目录名以 0_ 开头的工作区不入库（写死约定）；excluded-workspaces.json
  （脚本同目录）的 excluded 数组按子串匹配补充排除；配置缺失/损坏时
  fail-closed 退出（拒绝无保护运行）。
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const sinceSeq = args.sinceSeq !== undefined ? Number(args.sinceSeq) : undefined;
  const checkpoint = args.checkpoint ? loadCheckpoint(args.checkpoint) : null;
  // per-session 窗口：--since-seq 全局阈值优先；否则用 checkpoint[sessionId]（无记录 = 全量）
  const seqFor = (sessionId) => (sinceSeq !== undefined ? sinceSeq : ((checkpoint && checkpoint[sessionId]) ?? 0));
  const targetDate = args.date || new Date().toISOString().slice(0, 10);
  initLogger(targetDate, args.logDir);
  log("INFO", "main", `G1 启动 args=${JSON.stringify({ session: !!args.session, sinceSeq, checkpoint: !!args.checkpoint, date: args.date, dryRun: args.dryRun, out: args.out, includeSubagents: args.includeSubagents, includeEmpty: args.includeEmpty })}`);

  try {
    // 收集目标 session 文件（Level 0 硬过滤）
    const filtered = { empty: 0, subagent: 0, noUser: 0, workspace: 0 };
    const selected = [];
    let files = [];
    if (args.session) {
      const sk = path.basename(path.dirname(path.dirname(args.session)));
      const excluded = loadExcludedWorkspaces();
      const decoded = decodeProjectKey(sk);
      const record = registryRecordFor(decoded);
      if (isWorkspaceExcluded(sk, decoded, excluded) || isPrefixedWorkspace(sk, decoded, record)) {
        log("ERROR", "filter", `--session 属于排除工作区，拒绝解析: ${sk} (${decoded})`);
        process.exit(1);
      }
      files = [{ file: args.session, dir: path.basename(path.dirname(args.session)) }];
    } else if (fs.existsSync(SESSIONS_ROOT)) {
      const excluded = loadExcludedWorkspaces();
      for (const projectDir of fs.readdirSync(SESSIONS_ROOT)) {
        const pd = path.join(SESSIONS_ROOT, projectDir);
        if (!fs.statSync(pd).isDirectory()) continue;
        if (projectDir === "Archived") continue;
        const decoded = decodeProjectKey(projectDir);
        const prefixCh = prefixedChannels(projectDir, decoded, registryRecordFor(decoded));
        if (isWorkspaceExcluded(projectDir, decoded, excluded) || prefixCh.length > 0) {
          filtered.workspace++;
          const reasons = [];
          if (prefixCh.length > 0) reasons.push(prefixCh.join(";"));
          if (isWorkspaceExcluded(projectDir, decoded, excluded)) reasons.push("排除名单");
          log("INFO", "filter", `工作区排除: ${projectDir} (${decoded}) [${reasons.join(";")}]`);
          continue;
        }
        for (const sessionDir of fs.readdirSync(pd)) {
          const f = path.join(pd, sessionDir, "session.jsonl.zstd");
          if (fs.existsSync(f)) files.push({ file: f, dir: sessionDir });
        }
      }
    }
    if (files.length === 0) {
      log("ERROR", "main", "未找到 session 文件（--session 或默认 sessions 目录）");
      process.exit(1);
    }
    log("INFO", "main", `候选 session 文件: ${files.length}（排除工作区 ${filtered.workspace} 个）`);

    // Level 0 过滤统计（filtered 已在上方枚举阶段初始化，含 workspace 计数）

    for (const { file, dir } of files) {
      const header = readSessionHeader(file);
      if (header.empty) { filtered.empty++; log("INFO", "filter", `空壳跳过: ${dir}`); continue; }
      if (!args.includeSubagents && (header.delegationDepth ?? 0) >= 1) {
        filtered.subagent++;
        log("INFO", "filter", `子代理跳过: ${dir} (depth=${header.delegationDepth}, origin=${header.origin})`);
        continue;
      }
      selected.push({ file, dir, header });
    }

    // 逐 session 解析（先收集，后判断无 user）
    const allByDate = new Map(); // date -> msgs[]
    let totalEvents = 0, totalMsgs = 0, totalUserTurns = 0;
    const dropSummary = { plugin: 0, garbage: 0, secret: 0, empty: 0, orphan: 0, total: 0 };
    const sessionStats = [];
    const lastSeqMap = {};   // sessionId -> 文件末尾 seq（checkpoint 候选）

    for (const { file, dir, header } of selected) {
      const { text, empty } = decodeSessionLog(file);
      if (empty) { log("WARN", "decode", `解码为空: ${dir}`); continue; }
      const events = parseEvents(text);
      totalEvents += events.length;

      const { msgs, dropped, userTurns } = extractMessages(events, seqFor(header.id));
      // 记录文件末尾 seq 作 checkpoint 候选（解析过即记录；无新内容也跟进，避免重复解析）
      if (events.length > 0) lastSeqMap[header.id] = events[events.length - 1].seq ?? 0;
      for (const k of Object.keys(dropSummary)) dropSummary[k] += dropped[k];
      totalMsgs += msgs.length;
      totalUserTurns += userTurns;

      sessionStats.push({ dir, id: header.id, userTurns, msgs: msgs.length, depth: header.delegationDepth });
      log("INFO", "session", `${dir}: ${events.length} 事件 → ${userTurns} turn / ${msgs.length} 消息 (depth=${header.delegationDepth})`);

      if (userTurns === 0 && !args.includeEmpty) {
        filtered.noUser++;
        log("INFO", "filter", `无真实 user 跳过: ${dir}`);
        continue;
      }

      const channel = channelForDir(dir);
      for (const m of msgs) {
        const date = toDateStr(m.ts);
        if (!date) continue;
        const time = toTimeStr(m.ts);
        const prefix = `[${date} ${time}${channel ? " " + channel : ""}] `;
        const entry = { role: m.role, content: prefix + m.content };
        if (!allByDate.has(date)) allByDate.set(date, []);
        allByDate.get(date).push(entry);
      }
    }

    // 日期过滤
    let dates = [...allByDate.keys()].sort();
    if (args.date) dates = dates.filter((d) => d === args.date);
    if (dates.length === 0) {
      log("WARN", "main", "无匹配日期的事件");
      if (!args.dryRun && args.resultFile) writeResultFile(args.resultFile, lastSeqMap, []);
      return;
    }

    // 统计报告（stdout + log）
    log("INFO", "main", `=== G1 解析统计 ===`);
    log("INFO", "main", `候选 ${files.length} / 过滤: 空壳${filtered.empty} 子代理${filtered.subagent} 无user${filtered.noUser} 工作区${filtered.workspace} / 纳入 ${selected.length - filtered.noUser}`);
    log("INFO", "main", `事件 ${totalEvents} / 清洗丢弃: 注入${dropSummary.plugin} 噪音${dropSummary.garbage} 凭据${dropSummary.secret} 空${dropSummary.empty} 孤儿${dropSummary.orphan}`);
    log("INFO", "main", `有效消息 ${totalMsgs} (${totalUserTurns} turn)`);
    for (const d of dates) {
      log("INFO", "main", `  ${d}: ${allByDate.get(d).length} 条消息`);
    }

    if (args.dryRun) {
      log("INFO", "main", "[dry-run] 不落盘。");
      return;
    }

    // 落盘：staging 目录 → 自校验 → 拷贝到正式目录（续号，不覆盖已有 P0）
    let totalBatches = 0;
    const copied = [];
    const copiedBatches = []; // 带日期前缀的相对路径（result-file 用）
    for (const d of dates) {
      const msgs = allByDate.get(d);
      const batches = buildBatches(msgs);
      const targetDir = path.join(args.out, d);
      const stagingDir = path.join(stagingRootFor(args.out), d);
      fs.mkdirSync(stagingDir, { recursive: true });

      // 续号：正式目录已有 P0_*.json 的最大编号 + 1
      const startNum = nextP0Number(targetDir);
      log("INFO", "write", `${d}: 续号起点 P0_${String(startNum).padStart(3, "0")}（正式目录 ${fs.existsSync(targetDir) ? fs.readdirSync(targetDir).filter(f => /^P0_/.test(f)).length : 0} 个已有 P0）`);

      // 写 staging
      const stagingFiles = [];
      for (let i = 0; i < batches.length; i++) {
        const name = `P0_${String(startNum + i).padStart(3, "0")}.json`;
        fs.writeFileSync(path.join(stagingDir, name), JSON.stringify(batches[i], null, 2), "utf8");
        stagingFiles.push(name);
      }

      // 自校验：文件数 > 0 且 JSON 可解析
      let ok = stagingFiles.length > 0;
      for (const name of stagingFiles) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(stagingDir, name), "utf8"));
          if (!Array.isArray(parsed)) throw new Error("不是数组");
        } catch (e) {
          ok = false;
          log("ERROR", "validate", `staging 校验失败 ${name}: ${e.message}`);
        }
      }

      if (!ok) {
        log("ERROR", "write", `${d}: staging 校验失败，不拷贝到正式目录（staging 保留 ${stagingDir} 供排查）`);
        continue;
      }

      // 拷贝到正式目录
      fs.mkdirSync(targetDir, { recursive: true });
      for (const name of stagingFiles) {
        fs.copyFileSync(path.join(stagingDir, name), path.join(targetDir, name));
        copied.push(name);
        copiedBatches.push(`${d}/${name}`);
        totalBatches++;
      }
      // G4: 写 DSH batch 标记 sidecar（daemon 据此给 memory.add 加 source="DSH"）
      // 追加模式：合并本次与已有 sidecar（补跑时保留历史 DSH batch 标记）
      try {
        const sidecarPath = path.join(targetDir, ".dsh-batch-list.json");
        let dshList = [];
        if (fs.existsSync(sidecarPath)) {
          try { dshList = JSON.parse(fs.readFileSync(sidecarPath, "utf8")); } catch { dshList = []; }
        }
        for (const name of stagingFiles) {
          if (!dshList.includes(name)) dshList.push(name);
        }
        fs.writeFileSync(sidecarPath, JSON.stringify(dshList, null, 2), "utf8");
        log("INFO", "write", `${d}: sidecar 已更新（${dshList.length} 个 DSH batch）`);
      } catch (e) {
        log("WARN", "write", `sidecar 写入失败（不影响 batch）: ${e.message}`);
      }
      log("INFO", "write", `${d}: 拷贝 ${stagingFiles.length} 个 batch → ${targetDir}`);
    }
    // 写 result（导入候选；dry-run 不写）
    if (!args.dryRun && args.resultFile) writeResultFile(args.resultFile, lastSeqMap, copiedBatches);
    log("INFO", "main", `完成: ${totalBatches} 个 batch 已写入 ${args.out}/（${copied.join(", ")}）`);
  } catch (e) {
    log("ERROR", "main", `G1 执行失败: ${e.stack || e.message}`);
    process.exit(1);
  } finally {
    closeLogger();
  }
}

// 未捕获异常落盘（WTS 无 stdout 重定向，失败必须可追查）
process.on("uncaughtException", (err) => {
  try {
    const logDir = DEFAULT_LOG_DIR;
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, `g1-uncaught-${new Date().toISOString().slice(0, 10)}.log`),
      `[${new Date().toISOString()}] UNCAUGHT in g1-session-parser.mjs: ${err.stack || err}\n---\n`, "utf8");
  } catch {}
  console.error("[g1] 未捕获异常，详情已落盘", err);
  process.exit(1);
});

main().catch((e) => { console.error(e); process.exit(1); });
