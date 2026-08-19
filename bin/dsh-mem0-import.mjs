#!/usr/bin/env node
/**
 * dsh-mem0-import — DSH 会话记忆导入命令（dsh-mem0-memory 三件套之一）
 *
 * 链条：G1 解析（per-session 增量窗口）→ 收集批次 → POST server /import
 *       → 全部成功才落 checkpoint（失败不更新，下次重跑，mem0 hash 去重兜底）。
 *
 * 用法：
 *   node dsh-mem0-import.mjs                # --since-last（默认）：读 checkpoint 增量导入
 *   node dsh-mem0-import.mjs --full         # 全量首导（忽略 checkpoint，导入后建立）
 *   node dsh-mem0-import.mjs --session <f>  # 只导指定 session 文件
 *   node dsh-mem0-import.mjs --dry-run      # 只解析统计，不 POST 不落 checkpoint
 *
 * 并发安全：运行前抢 .import.lock（checkpoint 同级）。锁文件只写不删——
 *   下次运行按 PID 存活检测：持有者还活着 = 真锁，本次跳过；已死 = 残留锁，覆盖接管。
 * 失败语义：任一批次 POST 失败 → 退出码 1，checkpoint 不动。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_G1 = path.join(SCRIPT_DIR, "..", "scripts", "g1-session-parser.mjs");
const DEFAULT_SERVER = "http://127.0.0.1:18200";
const DEFAULT_DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const BATCH_TIMEOUT_MS = 120000;

function parseArgs(argv) {
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    full: argv.includes("--full"),
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
    session: get("--session"),
    server: get("--server") ?? DEFAULT_SERVER,
    dshHome: get("--dsh-home") ?? DEFAULT_DSH_HOME,
    out: get("--out"),
    logDir: get("--log-dir"),
    script: get("--script") ?? DEFAULT_G1,
    timeoutMs: Number(get("--timeout-ms") ?? BATCH_TIMEOUT_MS),
  };
}

const USAGE = `dsh-mem0-import — DSH 会话记忆导入命令（G1 → mem0-server /import → checkpoint）

用法:
  node dsh-mem0-import.mjs [选项]

选项:
  --since-last（默认）  读 checkpoint 增量导入（无 checkpoint = 全量首导）
  --full                全量导入（忽略 checkpoint，导入后建立）
  --session <file>      只导入指定 session 文件
  --server <url>        mem0-server 地址（默认 http://127.0.0.1:18200）
  --dsh-home <dir>      DSH 数据根（默认 $DSH_HOME 或 ~/.dsh）
  --out <dir>           G1 批次输出目录（默认 $DSH_HOME/tmp/dsh-memory-g1）
  --log-dir <dir>       G1 日志目录（默认 $DSH_HOME/logs）
  --script <path>       g1-session-parser.mjs 路径（默认同包 scripts/ 下）
  --timeout-ms <N>      单批次 POST 超时（默认 120000）
  --force               接管残留 .import.lock（PID 已死的锁）
  --dry-run             只解析统计，不 POST 不落 checkpoint
  -h, --help            显示本帮助

checkpoint: <dsh-home>/mem0/import-state.json（{sessionId: lastSeq}）
`;

const log = (level, phase, msg) => console.log(`[${new Date().toISOString()}] [${level}] [${phase}] ${msg}`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  // 统一绝对路径（G1 由子进程继承 cwd，但 checkpoint/锁必须在稳定位置）
  args.dshHome = path.resolve(args.dshHome);
  if (args.out) args.out = path.resolve(args.out);
  if (args.logDir) args.logDir = path.resolve(args.logDir);
  if (args.session) args.session = path.resolve(args.session);
  if (args.script) args.script = path.resolve(args.script);

  const checkpointPath = path.join(args.dshHome, "mem0", "import-state.json");
  const lockPath = `${checkpointPath}.lock`;
  const pendingPath = `${checkpointPath}.pending.json`;

  // ── 锁（只写不删；PID 存活检测区分真锁/残留锁）──
  if (fs.existsSync(lockPath)) {
    let holderPid = null;
    try { holderPid = JSON.parse(fs.readFileSync(lockPath, "utf8")).pid ?? null; } catch {}
    const alive = holderPid != null && (() => { try { process.kill(holderPid, 0); return true; } catch { return false; } })();
    if (alive && !args.force) {
      log("WARN", "lock", `另一导入进程在跑（pid=${holderPid}），本次跳过；确认无进程后可 --force 接管`);
      return 0;
    }
    log("WARN", "lock", alive ? "--force 接管运行中的导入" : `残留锁（pid=${holderPid} 已死），接管`);
  }
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));

  try {
    // ── 构造 G1 调用 ──
    const g1Args = ["--result-file", pendingPath];
    if (args.session) g1Args.push("--session", args.session);
    if (!args.full && fs.existsSync(checkpointPath)) g1Args.push("--checkpoint", checkpointPath);
    if (args.out) g1Args.push("--out", args.out);
    if (args.logDir) g1Args.push("--log-dir", args.logDir);
    if (args.dryRun) g1Args.push("--dry-run");

    log("INFO", "import", `G1: node ${args.script} ${g1Args.join(" ")}`);
    // 把 --dsh-home 传给 G1（DSH_HOME env 控制 sessions 扫描根）
    const g1 = spawnSync(process.execPath, [args.script, ...g1Args], {
      encoding: "utf8",
      timeout: 600000,
      env: { ...process.env, DSH_HOME: args.dshHome },
    });
    if (g1.status !== 0) {
      log("ERROR", "import", `G1 失败（exit=${g1.status}）: ${(g1.stderr || g1.stdout || "").slice(-1000)}`);
      return 1;
    }
    const g1Tail = (g1.stdout || "").trim().split("\n").slice(-5).join("\n");
    if (g1Tail) log("INFO", "import", `G1 输出尾:\n${g1Tail}`);
    if (args.dryRun) {
      log("INFO", "import", "[dry-run] 不 POST 不落 checkpoint。");
      return 0;
    }

    // ── 读 G1 result（lastSeq + 本次批次清单）──
    let result;
    try {
      result = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
    } catch (e) {
      log("ERROR", "import", `G1 result 缺失/损坏（${pendingPath}）: ${e.message}`);
      return 1;
    }
    const batches = Array.isArray(result.batches) ? result.batches : [];
    const lastSeqMap = (result.lastSeq && typeof result.lastSeq === "object") ? result.lastSeq : {};
    log("INFO", "import", `G1 产出 ${batches.length} 个批次（${Object.keys(lastSeqMap).length} 个 session）`);

    if (batches.length === 0) {
      // 无新内容：仍把 lastSeq 落为 checkpoint（跟进文件末尾，避免重复解析）
      writeCheckpoint(checkpointPath, lastSeqMap);
      log("INFO", "import", "无新批次，checkpoint 已跟进（无事实变化）");
      return 0;
    }

    // ── 逐个 POST /import（source=DSH：发布版只有 G1 来源）──
    const outRoot = path.resolve(args.out || path.join(args.dshHome, "tmp", "dsh-memory-g1"));
    let posted = 0, addTotal = 0;
    for (const rel of batches) {
      const batchFile = path.join(outRoot, rel);
      let messages;
      try {
        messages = JSON.parse(fs.readFileSync(batchFile, "utf8"));
      } catch (e) {
        log("ERROR", "import", `批次读取失败 ${rel}: ${e.message}`);
        return 1;
      }
      const body = JSON.stringify({ messages, source: "DSH" });
      log("INFO", "import", `POST /import ${rel}（${messages.length} 条消息）...`);
      const resp = await awaitPost(`${args.server}/import`, body, args.timeoutMs);
      if (!resp.ok) {
        log("ERROR", "import", `POST 失败 ${rel}: ${resp.error}`);
        return 1;
      }
      posted++;
      addTotal += resp.add_count ?? 0;
      log("INFO", "import", `  → add=${resp.add_count ?? "?"} total=${resp.total ?? "?"}`);
    }

    // ── 全部成功 → 落 checkpoint ──
    writeCheckpoint(checkpointPath, lastSeqMap);
    log("INFO", "import", `完成: ${posted}/${batches.length} 批次导入（add=${addTotal}），checkpoint 已更新`);
    return 0;
  } finally {
    // 锁文件只写不删（AGENTS 红线）；下次按 PID 存活检测接管
    log("INFO", "lock", `锁留在 ${lockPath}（pid=${process.pid}，下次运行自动判定）`);
  }
}

function writeCheckpoint(checkpointPath, lastSeqMap) {
  const tmp = `${checkpointPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lastSeqMap, null, 2), "utf8");
  const parsed = JSON.parse(fs.readFileSync(tmp, "utf8")); // 写后校验
  if (!parsed || typeof parsed !== "object") throw new Error("checkpoint 自校验失败");
  fs.renameSync(tmp, checkpointPath);
  log("INFO", "import", `checkpoint 已落盘: ${checkpointPath}（${Object.keys(lastSeqMap).length} session）`);
}

function awaitPost(url, body, timeoutMs) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        resolve({ ok: r.ok && data.ok !== false, add_count: data.add_count, total: data.total, error: data.error || `HTTP ${r.status}` });
      })
      .catch((e) => resolve({ ok: false, error: e.name === "AbortError" ? "timeout" : e.message }))
      .finally(() => clearTimeout(timer));
  });
}

main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(e); process.exitCode = 1; });
