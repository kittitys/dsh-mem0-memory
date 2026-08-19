#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mem0-server.py — Mem0 常驻 HTTP 服务（dsh-mem0-memory 三件套之一）

启动时初始化一次 Memory()，后续通过 HTTP 请求调用。
（避免每次 spawn Python 都要重新加载向量库。）

用法：
  python mem0-server.py [--port 18200] [--host 127.0.0.1] [--data-dir ./mem0_store] [--env-file ./.env]

端点：
  POST /search   {"query": "...", "limit": 20, "date_from": null, "date_to": null, "source": null}
  POST /add      {"content": "...", "timestamp": null, "infer": true}
  POST /import   {"messages": [{role, content}, ...], "source": null, "timestamp": null, "infer": true}
  GET  /health

配置优先级：环境变量 > .env 文件（--env-file，默认 ./.env）> 内置默认值。

环境变量：
  MEM0_DATA_DIR          向量库数据目录（默认 --data-dir，再默认 ./mem0_store）
  MEM0_USER_ID           记忆归属 user_id（默认 "default"）
  MEM0_LLM_PROVIDER      LLM provider（默认 deepseek；可换 openai 等 mem0 支持值）
  MEM0_LLM_MODEL         LLM 模型（默认 deepseek-v4-flash）
  MEM0_LLM_BASE_URL      LLM base URL（默认 https://api.deepseek.com/v1）
  MEM0_LLM_API_KEY       LLM API key（兼容旧名 DEEPSEEK_API_KEY）
  MEM0_EMBEDDING_MODEL   embedding 模型（默认 Qwen/Qwen3-Embedding-8B，中文推荐）
  MEM0_EMBEDDING_BASE_URL embedding API base URL（默认 https://api.siliconflow.cn/v1）
  MEM0_EMBEDDING_API_KEY embedding API key（兼容旧名 SILICONFLOW_API_KEY）
  MEM0_EMBEDDING_DIMS    embedding 维度（默认 4096；首次建库后不可更改）

内置定制（随服务启动自动应用，不修改 mem0 安装源码，升级不丢）：
  - jieba 中文分词 BM25 补丁（monkey-patch lemmatize_for_bm25 ×3 引用点；失败仅 WARN）
  - 提取语言补丁（use_input_language=True——中文内容不被翻译成英文事实；失败仅 WARN）
  - DeepSeek 补丁（thinking=disabled 防 0 事实入库 + 去 response_format 防 v4 flash 空内容；失败仅 WARN）
  - API client 超时补丁（embedding/deepseek 120s，对齐生产实测；失败仅 WARN）
  - 检索增强：hybrid + 关键词补捞 topup + embedding 故障降级（keyword fallback）
  - G4 source 后置过滤（Qdrant local payload filter 不可靠，Python 层精确筛）
"""

import argparse
import io
import os
import sys
import time
import warnings
import threading

os.environ.setdefault("MEM0_TELEMETRY", "False")
os.environ.setdefault("POSTHOG_DISABLED", "1")
warnings.filterwarnings("ignore")

# Fix encoding on Windows
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from flask import Flask, request, jsonify
from mem0 import Memory
from mem0.configs.base import MemoryConfig

# --- Config（env > .env > 默认值）---
ENV_FILE = os.environ.get("MEM0_ENV_FILE", os.path.join(os.getcwd(), ".env"))
DATA_DIR = os.environ.get("MEM0_DATA_DIR", os.path.join(os.getcwd(), "mem0_store"))
_USER_ID = None  # 延迟求值：必须在 load_dotenv() 之后读取，否则 .env 的 MEM0_USER_ID 不生效


def get_user_id():
    """记忆归属 user_id（env/.env 的 MEM0_USER_ID，默认 "default"）。"""
    global _USER_ID
    if _USER_ID is None:
        _USER_ID = os.environ.get("MEM0_USER_ID", "default")
    return _USER_ID


# --- Globals ---
memory_instance = None
init_error = None
app = Flask(__name__)


def load_dotenv(path):
    """极简 .env 读取（不引入 python-dotenv 依赖）：KEY=VALUE 行，忽略注释/空行。
    已存在的环境变量优先（不覆盖）。文件不存在时静默跳过。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"[mem0-server] WARN: .env 读取失败（{path}）: {e}", flush=True)


def read_key(*names):
    """按序取第一个存在的环境变量值（.env 已并入 os.environ）。"""
    for n in names:
        v = os.environ.get(n, "")
        if v:
            return v
    return ""


def build_llm_config():
    provider = os.environ.get("MEM0_LLM_PROVIDER", "deepseek")
    cfg = {
        "model": os.environ.get("MEM0_LLM_MODEL", "deepseek-v4-flash"),
        "api_key": read_key("MEM0_LLM_API_KEY", "DEEPSEEK_API_KEY"),
        "temperature": 0.1,
        "top_p": 1.0,
        "max_tokens": 8000,
    }
    base_url = os.environ.get("MEM0_LLM_BASE_URL")
    if base_url:
        cfg["deepseek_base_url" if provider == "deepseek" else "openai_base_url"] = base_url
    elif provider == "deepseek":
        cfg["deepseek_base_url"] = "https://api.deepseek.com/v1"
    return provider, cfg


def build_embedder_config():
    return {
        "model": os.environ.get("MEM0_EMBEDDING_MODEL", "Qwen/Qwen3-Embedding-8B"),
        "openai_base_url": os.environ.get("MEM0_EMBEDDING_BASE_URL", "https://api.siliconflow.cn/v1"),
        "api_key": read_key("MEM0_EMBEDDING_API_KEY", "SILICONFLOW_API_KEY"),
        "embedding_dims": int(os.environ.get("MEM0_EMBEDDING_DIMS", "4096")),
    }


def apply_jieba_patch():
    """中文 BM25 分词补丁（运行时 monkey-patch，不修改 mem0 安装源码）。

    把 mem0 默认的 spaCy 英文 lemmatizer 替换为 jieba 中文分词——中文关键词
    （专有名词/ID/路径）才能在 BM25 通道精确命中（mem0 混合检索每次搜索都会
    调用 lemmatize_for_bm25）。
    注意：必须替换**全部引用点**——mem0 的 memory/main.py 与 utils/scoring.py
    都在模块顶部 `from ... import lemmatize_for_bm25` 绑定，只 patch 定义处
    无法覆盖写入侧 text_lemmatized 与 topup 归一化（实测：写入侧未分词 →
    SPLADE 对连续中文编码失效 → BM25 0 命中）。jieba 未安装或 patch 失败 →
    仅 WARN 降级，绝不中断服务启动。
    """
    try:
        import jieba
        import mem0.utils.lemmatization as lemm
        import mem0.memory.main as main_mod
        import mem0.utils.scoring as scoring_mod

        _PUNCT = set(" \t\n\r，。！？；：、\"''（）【】《》…—·~")

        def _zh_lemmatize(text):
            try:
                tokens = [t for t in jieba.cut(text) if t.strip() and not all(ch in _PUNCT for ch in t)]
                return " ".join(tokens)
            except Exception:
                return text

        lemm.lemmatize_for_bm25 = _zh_lemmatize
        if getattr(main_mod, "lemmatize_for_bm25", None) is not _zh_lemmatize:
            main_mod.lemmatize_for_bm25 = _zh_lemmatize
        if getattr(scoring_mod, "lemmatize_for_bm25", None) is not _zh_lemmatize:
            scoring_mod.lemmatize_for_bm25 = _zh_lemmatize
        print("[mem0-server] jieba 中文分词补丁已启用（monkey-patch lemmatize_for_bm25 ×3 引用点）", flush=True)
        return True
    except ImportError:
        print("[mem0-server] WARN: jieba 未安装，BM25 中文分词降级为默认行为（pip install jieba）", flush=True)
    except Exception as e:
        print(f"[mem0-server] WARN: jieba 补丁应用失败（{e}），继续使用默认行为", flush=True)
    return False


def apply_language_patch():
    """提取语言补丁（monkey-patch，不修改 mem0 安装源码）。

    问题：mem0 默认把输入内容提取成**英文**事实——中文对话会被 LLM 翻译成
    英文落库（实测），中文关键词检索（BM25 通道）随之失效。
    修复：mem0 2.x 的 generate_additive_extraction_prompt 原生支持
    use_input_language=True（prompt 追加 Language Requirement 段），只是
    memory/main.py 调用处默认不传。这里包装该函数强制开启。
    注：main.py 在模块顶部 from ... import 绑定，需同步替换模块内名字。
    """
    try:
        import mem0.configs.prompts as prompts_mod
        import mem0.memory.main as main_mod

        _orig = prompts_mod.generate_additive_extraction_prompt

        def _patched(*args, **kwargs):
            kwargs["use_input_language"] = True
            return _orig(*args, **kwargs)

        prompts_mod.generate_additive_extraction_prompt = _patched
        if getattr(main_mod, "generate_additive_extraction_prompt", None) is _orig:
            main_mod.generate_additive_extraction_prompt = _patched
        print("[mem0-server] 提取语言补丁已启用（use_input_language=True，事实按输入语言提取）", flush=True)
        return True
    except Exception as e:
        print(f"[mem0-server] WARN: 提取语言补丁应用失败（{e}），事实可能被提取为英文", flush=True)
        return False


def apply_deepseek_patch():
    """DeepSeek 补丁（monkey-patch，不修改 mem0 安装源码）。

    两个问题（均取自生产环境实测排雷）：
    ① deepseek-v4-flash 默认 thinking=enabled，会把 max_tokens 预算全部烧在
       reasoning 上（finish_reason=length, content=""），mem0 静默视为
       「0 事实提取」（add=0）→ 请求带 extra_body={"thinking": {"type": "disabled"}}。
    ② deepseek-v4-flash 在 response_format=json_object + 长 prompt 时会返回
       空内容（生产实测注释）→ **不传递 response_format**（依赖 prompt 内的
       JSON 示例，main.py 侧用 json.loads 解析）。
    方法体复制自 mem0 2.0.7 llms/deepseek.py 的 generate_response，
    按生产验证过的行为调整；mem0 升级后需同步核对。
    """
    try:
        import mem0.llms.deepseek as ds

        def _patched(self, messages, response_format=None, tools=None, tool_choice="auto", **kwargs):
            params = self._get_supported_params(messages=messages, **kwargs)
            params.update(
                {
                    "model": self.config.model,
                    "messages": messages,
                }
            )
            # [mem0-server patch] 不传 response_format：deepseek-v4-flash 在
            # json_object + 长 prompt 下返回空内容（生产实测），依赖 prompt 内 JSON 示例
            if tools:
                params["tools"] = tools
                params["tool_choice"] = tool_choice
            # [mem0-server patch] 强制关闭 thinking：机械提取任务不需要链式思考，
            # 且 deepseek-v4-flash 默认 thinking 会烧光 max_tokens 导致 0 事实入库
            params["extra_body"] = {"thinking": {"type": "disabled"}}
            response = self.client.chat.completions.create(**params)
            return self._parse_response(response, tools)

        ds.DeepSeekLLM.generate_response = _patched
        print("[mem0-server] DeepSeek 补丁已启用（thinking=disabled + 去 response_format）", flush=True)
        return True
    except Exception as e:
        print(f"[mem0-server] WARN: DeepSeek 补丁应用失败（{e}），DeepSeek 提取可能异常", flush=True)
        return False


def apply_timeout_patch():
    """API client 超时补丁（monkey-patch，不修改 mem0 安装源码）。

    mem0 官方构造 OpenAI client 时不设 timeout（默认 600s），embedding/LLM
    API 长时间无响应会拖住 /search 与 /add 线程。生产环境实测将其收紧为
    120s（对齐生产行为）。仅包装 __init__ 后设置 client.timeout，失败静默。
    """
    try:
        import httpx

        import mem0.embeddings.openai as emb
        import mem0.llms.deepseek as ds

        def _wrap_init(cls):
            _orig = cls.__init__

            def _patched(self, *args, **kwargs):
                _orig(self, *args, **kwargs)
                try:
                    self.client.timeout = httpx.Timeout(120.0)
                except Exception:
                    pass

            cls.__init__ = _patched

        _wrap_init(emb.OpenAIEmbedding)
        _wrap_init(ds.DeepSeekLLM)
        print("[mem0-server] client 超时补丁已启用（embedding/deepseek 120s）", flush=True)
        return True
    except Exception as e:
        print(f"[mem0-server] WARN: client 超时补丁应用失败（{e}）", flush=True)
        return False


def init_memory():
    """Initialize Memory instance (called once at startup)."""
    global memory_instance, init_error
    if memory_instance is not None:
        return memory_instance
    try:
        print(f"[mem0-server] Initializing Memory()...", flush=True)
        t0 = time.time()

        llm_provider, llm_config = build_llm_config()
        embedder_config = build_embedder_config()
        embedding_dims = embedder_config["embedding_dims"]

        config = MemoryConfig(
            llm={
                "provider": llm_provider,
                "config": llm_config,
            },
            embedder={
                "provider": "openai",
                "config": embedder_config,
            },
            vector_store={
                "provider": "qdrant",
                "config": {
                    "path": DATA_DIR,
                    "embedding_model_dims": embedding_dims,
                },
            },
            history_db_path=os.path.join(DATA_DIR, "history.db"),
            version="v1.1",
        )
        memory_instance = Memory(config)
        elapsed = time.time() - t0
        print(f"[mem0-server] Memory() initialized in {elapsed:.1f}s", flush=True)
        return memory_instance
    except Exception as e:
        init_error = str(e)
        print(f"[mem0-server] Memory() init failed: {e}", flush=True)
        raise


# --- Lock cleanup ---
def clean_lock():
    try:
        lock_file = os.path.join(DATA_DIR, ".lock")
        if os.path.exists(lock_file):
            os.remove(lock_file)
    except Exception:
        pass


# --- Routes ---

@app.route("/health", methods=["GET"])
def health():
    if memory_instance is None:
        if init_error:
            return jsonify({"ok": False, "status": "init_failed", "error": init_error[:300]})
        return jsonify({"ok": True, "status": "initializing"})
    # Lightweight: only verify the Memory instance exists. Do not run a real search
    # here; concurrent long searches can block the embedding model / Qdrant client and
    # cause the watchdog health check to time out, which kills the server.
    return jsonify({"ok": True, "status": "healthy", "sample_results": 0})


@app.route("/search", methods=["POST"])
def search():
    if memory_instance is None:
        return jsonify({"ok": False, "error": "Memory not initialized"}), 503

    data = request.get_json(force=True)
    query = data.get("query", "")
    limit = data.get("limit", 20)
    date_from = data.get("date_from")
    date_to = data.get("date_to")
    fact_type = data.get("fact_type")  # optional: "identity"|"preference"|"decision"|"relationship"|"emotional_landmark"
    source = data.get("source")  # 2026-08-19 G4: optional "DSH"（G1 导入）/ "supplemental-extraction" 等

    if not query:
        return jsonify({"ok": False, "error": "query is required"}), 400

    # build base filters
    filters = {"user_id": get_user_id()}
    if fact_type:
        filters["fact_type"] = fact_type
    # 2026-08-19 G4 修复：source 不放进 mem0 filters！
    # Qdrant local 的 payload filter 有限（payload 索引无效 + 缺失字段不被正确排除，
    # 详见 mem0 库内 2026-07-06 记录的三大限制），source 过滤改为 Python 层精确筛
    # （复用 date-filter 的成熟模式）。若放进 filters，空 source 记录会混入结果。

    start = time.time()

    degraded = False
    mode = "hybrid"
    topup = 0
    try:
        try:
            if not date_from and not date_to:
                if source:
                    # 先放大 top_k 查询（source 筛完可能不足 limit），再 Python 层精确过滤
                    # 注意：mem0 Memory.search 参数名是 top_k（不是 limit，limit 会被
                    # **kwargs 吞掉——2026-08-19 实测发现的历史 bug，此前放大从未生效）
                    res = memory_instance.search(query, filters=filters, top_k=max(limit * 5, 100))
                    res = _post_filter_by_source(res, source, limit)
                    res, topup = _topup_with_keyword(res, query, filters, limit, source=source)
                else:
                    res = memory_instance.search(query, filters=filters, top_k=limit)
                    res, topup = _topup_with_keyword(res, query, filters, limit)
            else:
                # Date-filtered search: scroll + re-rank (from bridge.py logic)
                res = _search_with_date_filter(query, limit, date_from, date_to, fact_type=fact_type, source=source)
        except Exception as e:
            # 2026-08-19：dense embedding 故障降级 → 本地 BM25 关键词通道（离线可用）。
            # 触发条件：embedding API 不可用/超时（主路径抛异常）。降级模式不做日期过滤。
            try:
                res = _search_keyword_fallback(query, filters, limit, source=source)
                degraded = True
                mode = "keyword"
                print(f"[mem0-server] /search degraded → keyword fallback (primary: {str(e)[:150]})", flush=True)
            except Exception:
                raise e
        if topup:
            print(f"[mem0-server] /search keyword top-up: +{topup} (hybrid {mode} path)", flush=True)

        elapsed = (time.time() - start) * 1000
        results = [
            {
                "id": r.get("id"),
                "memory": r.get("memory"),
                "score": r.get("score"),
                "metadata": r.get("metadata", {}),
            }
            for r in res.get("results", [])
        ]
        return jsonify({
            "ok": True,
            "query": query,
            "count": len(results),
            "elapsed_ms": round(elapsed, 2),
            "degraded": degraded,
            "mode": mode,
            "topup": topup,
            "results": results,
        })
    except Exception as e:
        elapsed = (time.time() - start) * 1000
        return jsonify({"ok": False, "error": str(e)[:300], "elapsed_ms": round(elapsed, 2)})


@app.route("/add", methods=["POST"])
def add():
    if memory_instance is None:
        return jsonify({"ok": False, "error": "Memory not initialized"}), 503

    data = request.get_json(force=True)
    content = data.get("content", "")
    timestamp = data.get("timestamp")
    infer = data.get("infer", True)

    if not content:
        return jsonify({"ok": False, "error": "content is required"}), 400

    try:
        metadata = {"user_id": get_user_id()}
        if timestamp:
            metadata["timestamp"] = timestamp

        # mem0 v2 API: Memory.add(messages=[...], user_id=..., metadata=..., infer=...)
        # （v1 的 data= 已移除；user_id 是独立关键字参数，不在 metadata 里）
        kwargs = {"messages": [{"role": "user", "content": content}], "user_id": get_user_id(), "metadata": metadata}
        if not infer:
            kwargs["infer"] = False

        result = memory_instance.add(**kwargs)
        return jsonify({"ok": True, "result": result})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)[:300]})


@app.route("/import", methods=["POST"])
def import_batch():
    """导入对话批次（P2.2，通用导入链的入库端）。

    body: {"messages": [{role, content}, ...], "source": "DSH"|null,
           "timestamp": null, "infer": true}
    一次调用 = 一个对话批次 → memory.add(messages)（mem0 v2 原生多轮语义）。
    结构校验复用生产 daemon 的 structure guard 模式（防外来 JSON 文件把
    memory.add 打炸）；source 由调用方显式传入（发布版只有 DSH 来源）。
    """
    if memory_instance is None:
        return jsonify({"ok": False, "error": "Memory not initialized"}), 503

    data = request.get_json(force=True)
    messages = data.get("messages")
    source = data.get("source")
    timestamp = data.get("timestamp")
    infer = data.get("infer", True)

    if not isinstance(messages, list) or len(messages) == 0:
        return jsonify({"ok": False, "error": "messages (non-empty array) is required"}), 400
    # structure guard（生产 daemon 模式）：每个元素必须是含 role/content 的消息 dict
    for item in messages:
        if not isinstance(item, dict) or not item.get("role") or not item.get("content"):
            return jsonify({"ok": False, "error": "invalid message structure (need {role, content} dicts)"}), 400

    try:
        metadata = {"user_id": get_user_id()}
        if source:
            metadata["source"] = source
        if timestamp:
            metadata["timestamp"] = timestamp

        kwargs = {"messages": messages, "user_id": get_user_id(), "metadata": metadata}
        if not infer:
            kwargs["infer"] = False

        result = memory_instance.add(**kwargs)
        results = (result or {}).get("results", [])
        add_count = sum(1 for r in results if isinstance(r, dict) and r.get("event") == "ADD")
        return jsonify({"ok": True, "result": result, "add_count": add_count, "total": len(results)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)[:300]})


def _dense_vector(point):
    """Extract the dense vector from a Qdrant point, ignoring sparse vectors like 'bm25'."""
    import numpy as np
    v = point.vector
    if v is None:
        return None
    # Single default (unnamed) vector
    if isinstance(v, (list, tuple)):
        return np.asarray(v, dtype=np.float32)
    # Named vectors: prefer non-sparse vector names
    if isinstance(v, dict):
        for name, vec in v.items():
            if name != "bm25" and isinstance(vec, (list, tuple)):
                return np.asarray(vec, dtype=np.float32)
    return None


def _post_filter_by_source(res, source, limit):
    """Python 层按 metadata.source 精确过滤（2026-08-19 G4 修复）。

    Qdrant local 的 payload filter 不可靠（缺失字段不被正确排除、payload 索引无效），
    source 过滤必须走 Python 层——与 date-filter 的 scroll+重排模式同构。
    从已查询的候选（res.results）中筛出 source 精确匹配的，取前 limit 条。
    """
    if not source:
        return res
    filtered = [r for r in res.get("results", []) if (r.get("metadata") or {}).get("source") == source]
    res["results"] = filtered[:limit]
    res["count"] = len(res["results"])
    return res


def _search_keyword_fallback(query, filters, limit, source=None):
    """Embedding API 故障降级：本地 BM25 关键词通道（2026-08-19）。

    dense embedding 依赖外部 API（SiliconFlow），故障时主路径抛异常。
    本函数用 mem0 内置 keyword_search（fastembed Qdrant/bm25 本地模型 +
    jieba 中文分词补丁，均离线可用）做 sparse-only 检索——关键词硬匹配兜底。
    结果在 /search 响应中带 degraded/mode 标记，调用方（DSH bridge /
    OpenClaw mem0_search）可据此提示当前为降级模式。
    注意：降级模式不支持日期过滤（Qdrant local 无 range filter，且无 dense
    可重排）；date_from/date_to 在降级时被忽略，由响应标记明示。
    """
    from mem0.utils.lemmatization import lemmatize_for_bm25

    vs = memory_instance.vector_store
    topk = max(limit * 5, 100) if source else max(limit, 10)
    hits = vs.keyword_search(lemmatize_for_bm25(query), top_k=topk, filters=filters)
    if hits is None:
        raise RuntimeError("BM25 keyword search unavailable (collection 无 bm25 槽位或 fastembed 缺失)")

    results = []
    for p in hits:
        payload = p.payload or {}
        # mem0 2.x payload 为扁平结构：事实文本在 "data"，source/timestamp/fact_type
        # 等平铺在顶层（不在 "metadata" 子对象）——与 hybrid 路径返回的
        # {id, memory, score, metadata} 形状对齐，供 _post_filter_by_source 与调用方使用
        results.append({
            "id": str(p.id),
            "memory": payload.get("data", ""),
            "score": float(p.score),
            "metadata": dict(payload),
        })
    res = {"results": results, "count": len(results)}
    if source:
        res = _post_filter_by_source(res, source, limit)
    else:
        res["results"] = res["results"][:limit]
        res["count"] = len(res["results"])
    return res


def _topup_with_keyword(res, query, filters, limit, source=None):
    """混合检索补捞（2026-08-19）：mem0 标准 hybrid 的候选集只来自语义侧
    （BM25 只能给语义候选加分，纯关键词命中的记忆会被丢弃）。当结果不足
    limit 时，用本地 BM25 关键词检索补捞，按 id 去重合并。
    关键词分用 mem0 自己的 sigmoid 归一化（normalize_bm25）到 [0,1]，
    与 hybrid 分数同尺度排序。返回 (res, 补捞条数)。
    """
    cur = res.get("results", [])
    if len(cur) >= limit:
        return res, 0
    try:
        # 检索深度取大：短查询（如「装配壳」）的 BM25 命中可能排在较后，
        # 且 source 后置过滤会再砍一层——topk 太小会补捞失败（2026-08-19 实测）
        kw = _search_keyword_fallback(query, filters, max(limit * 10, 50), source=source)
        from mem0.utils.scoring import get_bm25_params, normalize_bm25
        midpoint, steepness = get_bm25_params(query)
        seen = {str(r.get("id")) for r in cur}
        added = 0
        for r in kw.get("results", []):
            if str(r.get("id")) in seen:
                continue
            raw = r.get("score") or 0.0
            r["score"] = normalize_bm25(raw, midpoint, steepness)
            cur.append(r)
            added += 1
    except Exception:
        return res, 0
    if added == 0:
        return res, 0
    cur.sort(key=lambda x: x.get("score") or 0.0, reverse=True)
    res["results"] = cur[:limit]
    res["count"] = len(res["results"])
    return res, added


def _search_with_date_filter(query, limit, date_from=None, date_to=None, fact_type=None, source=None):
    """Date-filtered search using stored vectors + Python re-rank.

    Optimization: instead of re-embedding every candidate in Python (which
    called the embedding model N times and dominated query latency), we scroll
    with the vectors already stored in Qdrant and compute cosine similarities
    in one batched numpy operation. This keeps the workaround for Qdrant local's
    lack of string range filters while removing the embedding bottleneck.
    """
    import numpy as np
    from qdrant_client.models import Filter, FieldCondition, MatchValue

    collection_name = "mem0"
    must_conditions = [FieldCondition(key="user_id", match=MatchValue(value=get_user_id()))]
    if fact_type:
        must_conditions.append(FieldCondition(key="metadata.fact_type", match=MatchValue(value=fact_type)))
    # 2026-08-19 G4 修复：source 不放进 Qdrant FieldCondition（local 模式不可靠），
    # 改为下方 Python 循环内精确匹配（与 date 过滤同层）。
    timestamp_filter = Filter(must=must_conditions)

    # Embed the query once
    query_embedding = np.asarray(
        memory_instance.embedding_model.embed(query),
        dtype=np.float32,
    )
    query_norm = np.linalg.norm(query_embedding)

    results = []
    vectors = []
    offset = None
    while True:
        batch = memory_instance.vector_store.client.scroll(
            collection_name=collection_name,
            scroll_filter=timestamp_filter,
            limit=1000,
            offset=offset,
            with_payload=True,
            with_vectors=True,  # use stored vectors, avoid re-embedding
        )
        points = batch[0]
        offset = batch[1]
        for p in points:
            meta = p.payload or {}
            if source and meta.get("source") != source:
                continue
            ts = meta.get("timestamp")
            if not ts:
                continue
            ts_day = ts.split("T")[0] if "T" in ts else ts
            if date_from and ts_day < date_from:
                continue
            if date_to and ts_day > date_to:
                continue
            memory_text = meta.get("data", "")
            if not memory_text:
                continue

            mem_vec = _dense_vector(p)
            if mem_vec is None:
                continue

            vectors.append(mem_vec)
            results.append({
                "id": p.id,
                "memory": memory_text,
                "metadata": meta,
            })
        if offset is None or len(points) == 0:
            break

    if vectors:
        # Batched cosine similarity: (N, D) x (D,) -> (N,)
        vectors = np.stack(vectors, axis=0)
        scores = np.dot(vectors, query_embedding) / (
            np.linalg.norm(vectors, axis=1) * query_norm + 1e-10
        )
        for i, score in enumerate(scores.tolist()):
            results[i]["score"] = score

    results.sort(key=lambda x: x["score"], reverse=True)
    return {"results": results[:limit]}


# --- Startup ---

def main():
    parser = argparse.ArgumentParser(description="Mem0 persistent HTTP server (dsh-mem0-memory)")
    parser.add_argument("--port", type=int, default=18200, help="HTTP port (default: 18200)")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--data-dir", default=None, help="Vector store data dir (default: $MEM0_DATA_DIR or ./mem0_store)")
    parser.add_argument("--env-file", default=None, help=".env file to load (default: ./.env)")
    args = parser.parse_args()

    global DATA_DIR
    env_file = args.env_file or ENV_FILE
    load_dotenv(env_file)
    if args.data_dir:
        DATA_DIR = args.data_dir
    elif os.environ.get("MEM0_DATA_DIR"):
        DATA_DIR = os.environ.get("MEM0_DATA_DIR")
    DATA_DIR = os.path.abspath(DATA_DIR)
    os.makedirs(DATA_DIR, exist_ok=True)

    print(f"[mem0-server] Starting on {args.host}:{args.port}", flush=True)
    print(f"[mem0-server] data-dir={DATA_DIR}  user_id={get_user_id()}  env-file={env_file}", flush=True)

    # Pre-init Memory in a background thread so Flask can still respond to /health
    def _init():
        try:
            clean_lock()
            apply_jieba_patch()
            apply_language_patch()
            apply_deepseek_patch()
            apply_timeout_patch()
            init_memory()
        except Exception as e:
            print(f"[mem0-server] Init error: {e}", flush=True)

    init_thread = threading.Thread(target=_init, daemon=True)
    init_thread.start()

    # Use threaded=True to handle concurrent requests (health check + search)
    # Without this, Flask dev server blocks and auto-recall health checks time out
    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
