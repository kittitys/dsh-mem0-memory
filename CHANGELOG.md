# Changelog

本项目遵循语义化版本（SemVer）。DSH 处于 Developer Preview（rc 系列），
插件随 DSH rc 发版节奏跟进；破坏性变更记录于此。

## [Unreleased]

### 0.1.5（2026-10-18）

- **适配 DSH 0.2.x（0.2.1-rc.2 实测）**，两处改动，缺一不可：
  1. **peer 范围放宽**：`@deepseek-ai/dsh-agent-loop` 由 `^0.1.0-rc.6`（= `>=0.1.0-rc.6 <0.2.0`）改为 **`^0.1.0-rc.6 || ^0.2.1-rc.2`**。0.2.1 起底座新增「插件兼容性硬校验」，旧范围会被判为不兼容并**拒绝安装 + 回滚**（`installation rejected: Plugin dsh-mem0-memory@0.1.4 is incompatible with dsh 0.2.1-rc.2`）。
      - 选**有界区间**而非 `*`/`>=`：本插件会向会话写入事件，声明「任何版本都支持」会在 DSH 大版本再变时静默踩雷（参见 2026-08-19 会话损坏事故）。0.3.x 起需重新验证后再放宽。
      - 覆盖：0.1.5-rc.3（旧线）✅、0.2.1-rc.2（新线）✅、0.2.x 后续 rc/补丁 ✅。
  2. **注入消息的 `source.kind` 改写**：`{ kind: "plugin", plugin: "dsh-mem0-memory", form: "recall" }` → **`{ kind: "plugin:dsh-mem0-memory", form: "recall" }`**。
      - 根因：0.2.x 引入 session format **v4**，其 `source()` 校验**明确禁止 `kind:"plugin"`**（要求生产者自有 kind，`plugin:<name>` 即 V3→V4 迁移器对未知插件的标准映射）。若只放宽 peer 不改这里，结果是「装得上、但每轮对话在注入后报 `format v4 message requires a producer-owned source kind` 而失败」——比装不上更糟。
      - 兼容性：0.1.x 的写入门槛只要求「kind 为非空字符串」，`kind:"plugin"` 的强校验仅针对 `system/message`，`user/message` 不受限 → 同一份代码在 0.1.x 与 0.2.x 上都能跑，无需按底座版本分支。
- 影响面：`lib/index.js`（注入点一处）、`package.json`（版本 + peer）；server / G1 解析器 / 导入命令未改动。
- 验证：0.2.1-rc.2 真实环境实跑（安装通过、注入链完整、会话可关闭重开、转录 v4 事件形态正确）。

### 0.1.4（2026-08-23）

- **server 自动拉起（autoStartServer）**：DSH 启动时插件探测 mem0 server 的 `/health`（3s 超时）——未在跑则自动 spawn 一次（`detached` 子进程，不随 DSH 退出）；已在跑则不动。用户装了插件 = 期望「与平台同步启动」，忘记手动开 server 也能工作。
- 设计铁律：① 只探测 HTTP /health（端口有响应 = 在跑，无论谁起的）；② 每个 DSH 进程最多 spawn 一次，失败仅 WARN 绝不重试（OpenClaw 侧 16 进程抢锁事故教训）；③ server 常驻，DSH 退出不带走（最小化动作）。
- 配置新增：`autoStartServer: true`（默认开，可关）+ `pythonPath`（可选，spawn 用 python 路径，默认 `python`/`python3`）。

### 0.1.3（2026-08-22）

- **工作区排除（召回侧）**：排除工作区的会话不再召回/注入记忆——插件通过 `ctx.agents.requireInitiator()` 获取当前会话 cwd，判定与 G1 写入侧一致：cwd 路径段 `0_` 前缀（写死约定）+ 新增 `excludeWorkspaces` 配置（名单子串匹配，对应 G1 excluded-workspaces.json）。排除工作区对话省去召回延时（每轮 5-10s），内容本就不入库。
- 配置新增：`excludeWorkspaces: []`（默认空；如 `["财富密码"]`）。

### 0.1.2（2026-08-22）

- **降级可见性**：embedding API 故障触发关键词降级时，召回注入块现在会带警告行「⚠️ 注意：embedding 服务超时/故障，以下为降级关键词搜索结果（语义通道暂不可用），召回覆盖度可能下降。」——插件此前丢弃了 server 响应的 `degraded/mode` 标记，降级期间会话对结果质量下降毫不知情；已透传并对齐 OpenClaw 侧 mem0-memory 的 recall.js 实现。
- 行为：`formatBlock(items, degraded)` 新增降级分支；`recallMemories` 返回透传 `degraded`/`mode`。

### 0.1.0（发布候选，待外部审查后发布）

- **2026-08-20 定名**：包名由 dsh-mem0-bridge 更名为 **dsh-mem0-memory**（发布前改名，无外部影响；插件 id mem0-memory，与 OpenClaw 侧插件命名一脉相承）。

首个公开版本（alpha）。三件套捆绑：插件 + 通用化 server + 导入命令。

**能力**：
- 插件：`agent/pre-step` 同步召回注入（limit/scoreThreshold/timeout/source/probePath/autoImport 全配置化）；`session/disposed` 自动增量导入
- server：hybrid 混合检索（top_k 修复）+ 关键词补捞 topup + embedding 故障降级；G4 source 后置过滤；`/search` `/add` `/import` `/health`
- G1 解析器：zstd 多帧扫描、两级清洗、user 锚点分组、per-session checkpoint 增量、工作区排除（0_ 前缀 + 名单，fail-closed）
- `dsh-mem0-import`：`--since-last`（默认）/`--full`/`--session`/`--dry-run`；全部成功才落 checkpoint；锁文件 PID 存活检测
- setup.py：`--check`/`--init`/`--install` 一键初始化 + .env 模板；start-server.bat/.sh 跨平台启动（健康自检）

**内置补丁（monkey-patch，不修改 mem0 安装）**：
- jieba 中文分词 BM25（×3 引用点：lemmatization/main/scoring）
- 提取语言 use_input_language=True（中文事实不被翻译成英文）
- DeepSeek thinking 关闭 + 去 response_format（防 0 事实入库 / v4-flash 空内容）
- API client 超时 120s

**去本机化**：零私有路径/数据/名单残留；API key 走 env/.env；mem0 依赖声明（mem0ai>=2.0）。

**已知边界**：DSH rc 破坏性变更未跟踪；mem0 上游 API 变化需跟进；DeepSeek 之外 LLM 未逐一适配。

### 上游致谢

- 召回后处理逻辑移植自 OpenClaw `mem0-memory` 插件（recall.js）
- zstd 帧解析移植自 DSH 官方 persistence 源码
- mem0（MIT）—— 向量记忆库
