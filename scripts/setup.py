#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
setup.py — dsh-mem0-memory 一键初始化（三件套之「装机服务」）

用法：
  python setup.py --init        检查/补依赖、建数据目录、生成 .env（不存在时）、打印下一步
  python setup.py --install     在 --init 基础上自动 pip 安装缺失依赖
  python setup.py --check       只检查环境（Python 版本 / 依赖 / key 配置状态），不改任何东西

职责（对应 README 安装五步的 ②③④）：
  1. Python 版本检查（>= 3.10）
  2. pip 依赖检查：mem0ai>=2.0 qdrant-client fastembed jieba flask（缺失 → 提示，--install 自动装）
  3. 建数据目录（默认 ./mem0_store，可被 MEM0_DATA_DIR 或 --data-dir 覆盖）
  4. 生成 .env（不存在时从 .env.example 复制；已存在不覆盖）
  5. 打印下一步（启动 server + 首次导入）
"""

import argparse
import importlib.metadata
import importlib.util
import io
import os
import shutil
import subprocess
import sys

# Windows 控制台默认 GBK：统一 UTF-8 输出（与 mem0-server.py 一致）
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# (分发名 pip 名, import 模块名, 最低版本) —— 注意 mem0ai vs mem0、qdrant-client vs qdrant_client
REQUIRED = [
    ("mem0ai", "mem0", "2.0"),
    ("qdrant-client", "qdrant_client", None),
    ("fastembed", "fastembed", None),
    ("jieba", "jieba", None),
    ("flask", "flask", None),
]


def py_version_ok():
    return sys.version_info >= (3, 10)


def check_dependency(dist_name, import_name, min_version):
    ok = importlib.util.find_spec(import_name) is not None
    if not ok:
        return False, None
    try:
        ver = importlib.metadata.version(dist_name)
    except Exception:
        ver = None
    if min_version and ver:
        def _norm(v):
            try:
                return tuple(int(x) for x in v.split(".")[:2])
            except Exception:
                return (0, 0)
        if _norm(ver) < _norm(min_version):
            return False, ver
    return True, ver


def load_dotenv_state(env_file):
    """只读 .env 看 key 是否已填（不修改环境）。"""
    filled = {}
    try:
        with open(env_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and v:
                    filled[k] = True
    except FileNotFoundError:
        pass
    return filled


def main():
    parser = argparse.ArgumentParser(description="dsh-mem0-memory 一键初始化")
    parser.add_argument("--init", action="store_true", help="检查/补依赖 + 建目录 + 生成 .env")
    parser.add_argument("--install", action="store_true", help="（与 --init 同用）自动 pip 安装缺失依赖")
    parser.add_argument("--check", action="store_true", help="只检查环境，不改任何东西")
    parser.add_argument("--data-dir", default=None, help="数据目录（默认 ./mem0_store 或 $MEM0_DATA_DIR）")
    args = parser.parse_args()

    mode = "check" if args.check else ("init" if args.init else None)
    if mode is None:
        parser.print_help()
        sys.exit(0)

    script_dir = os.path.dirname(os.path.abspath(__file__))
    env_example = os.path.join(script_dir, ".env.example")
    env_file = os.path.join(os.getcwd(), ".env")
    data_dir = args.data_dir or os.environ.get("MEM0_DATA_DIR") or os.path.join(os.getcwd(), "mem0_store")

    print("=" * 56)
    print(" dsh-mem0-memory setup")
    print("=" * 56)

    # 1) Python 版本
    print(f"[1/4] Python: {sys.version.split()[0]} (需要 >= 3.10)")
    if not py_version_ok():
        print("  FAIL: Python 版本过低，请升级到 3.10+")
        sys.exit(1)

    # 2) 依赖
    print("[2/4] 依赖检查:")
    missing = []
    for dist_name, import_name, minv in REQUIRED:
        ok, ver = check_dependency(dist_name, import_name, minv)
        if ok:
            print(f"  ✅ {dist_name} {ver or ''}".rstrip())
        else:
            print(f"  ❌ {dist_name} {('(需要 >= ' + minv + '，当前 ' + str(ver) + ')') if (minv and ver) else ('(需要 >= ' + minv + ')' if minv else '未安装')}")
            missing.append(dist_name)

    if mode == "check":
        env_state = load_dotenv_state(env_file) if os.path.exists(env_file) else {}
        key_state = "已填" if env_state.get("MEM0_LLM_API_KEY") or os.environ.get("MEM0_LLM_API_KEY") else "未填"
        emb_state = "已填" if env_state.get("MEM0_EMBEDDING_API_KEY") or os.environ.get("MEM0_EMBEDDING_API_KEY") else "未填"
        print(f"  .env: {'存在' if os.path.exists(env_file) else '不存在'}（LLM key {key_state} / embedding key {emb_state}）")
        print(f"  数据目录: {data_dir}（{'存在' if os.path.isdir(data_dir) else '不存在'}）")
        ok = not missing and py_version_ok()
        print("=" * 56)
        print(" ✅ 环境就绪" if ok else " ❌ 有缺失项，运行 `python setup.py --init [--install]`")
        sys.exit(0 if ok else 1)

    # init 模式
    if missing:
        cmd = " ".join(f"pip install {m}" for m in missing)
        if args.install:
            print(f"  ↳ 自动安装: {cmd}")
            r = subprocess.run(cmd, shell=True)
            if r.returncode != 0:
                print("  FAIL: pip 安装失败，请手动执行上面的命令")
                sys.exit(1)
            for m in list(missing):
                entry = next((e for e in REQUIRED if e[0] == m), None)
                ok, _ = check_dependency(entry[0], entry[1], entry[2]) if entry else (False, None)
                if ok:
                    missing.remove(m)
            if missing:
                print(f"  FAIL: 仍有缺失: {missing}")
                sys.exit(1)
        else:
            print(f"  ↳ 运行: {cmd}")
            print("  （或加 --install 自动安装）")
            sys.exit(1)

    # 3) 数据目录
    print("[3/4] 数据目录:")
    if os.path.isdir(data_dir):
        print(f"  ✅ 已存在: {data_dir}")
    else:
        os.makedirs(data_dir, exist_ok=True)
        print(f"  ✅ 已创建: {data_dir}")

    # 4) .env
    print("[4/4] 环境配置:")
    if os.path.exists(env_file):
        print(f"  ✅ .env 已存在（不覆盖）: {env_file}")
    elif os.path.exists(env_example):
        shutil.copy2(env_example, env_file)
        print(f"  ✅ 已从模板生成: {env_file}")
        print("  ⚠️  请编辑 .env 填写 MEM0_LLM_API_KEY 与 MEM0_EMBEDDING_API_KEY")
    else:
        print(f"  ❌ 模板缺失: {env_example}（发布包异常）")
        sys.exit(1)

    print("=" * 56)
    print(" ✅ setup 完成。下一步：")
    print(f"   1. 编辑 {env_file} 填写两个 API key")
    print("   2. 启动 server：")
    print("      - Windows: start-server.bat        （或 python mem0-server.py --port 18200）")
    print("      - Linux/macOS: ./start-server.sh   （或 python mem0-server.py --port 18200）")
    print("   3. 首次导入历史会话：node dsh-mem0-import.mjs --since-last")
    print("      （或由插件在会话结束时自动增量导入）")
    print("=" * 56)


if __name__ == "__main__":
    main()
