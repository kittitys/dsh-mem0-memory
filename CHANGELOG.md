# Changelog

本项目遵循语义化版本（SemVer）。DSH 处于 Developer Preview（rc 系列），
插件随 DSH rc 发版节奏跟进；破坏性变更记录于此。

## [Unreleased]

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
