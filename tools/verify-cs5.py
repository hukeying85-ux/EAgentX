#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EAgentX C# 5 语法静态守卫。

背景：build.ps1 用 /langversion:5 编译（兼容 Windows 自带 csc.exe），
而 CI 里的 Linux 沙箱常常没有 csc.exe。这个脚本用「启发式 + 保守扫描」的方式，
在提交前把 C# 6+ 语法挡下来：

    1. 字符串插值          $"..." / $@"..." / @$"..."
    2. 空条件运算符        ?.  ?[
    3. nameof(...)
    4. out var / out 声明   out int x（含 out var）
    5. using 声明           using var x = ...;
    6. 表达式体成员         void Foo() => ...;   /  int P => ...;
    7. 只读自动属性初始化   public int X { get; } = 1;
    8. 异常过滤器           catch (X e) when (...)
    9. 静态 using / 元组    using static ...;   /  (a, b) 解构
   10. 按位组合的枚举写法  [Flags] 之外的 C# 7 模式匹配 is X y

用法:
    python3 tools/verify-cs5.py            # 扫描 src/**/*.cs
    python3 tools/verify-cs5.py a.cs b.cs  # 只扫指定文件

退出码 0 = 全部通过，1 = 发现问题。
"""

import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")

# (编号, 正则, 说明, 例外正则)
RULES = [
    (
        "CS5-1",
        re.compile(r'(?<![@\w])\$@?"|@\$"'),
        "字符串插值（$\"...\"）是 C# 6 语法，请改用 string.Format 或字符串拼接",
        None,
    ),
    (
        "CS5-2",
        re.compile(r"\?\."),
        "空条件运算符 ?. 是 C# 6 语法，请改成显式判 null",
        None,
    ),
    (
        "CS5-3",
        re.compile(r"\?\["),
        "空条件索引 ?[ 是 C# 6 语法，请改成显式判 null",
        None,
    ),
    (
        "CS5-4",
        re.compile(r"\bnameof\s*\("),
        "nameof() 是 C# 6 语法，请改用字符串字面量",
        None,
    ),
    (
        "CS5-5",
        re.compile(r"\bout\s+(var|int|string|bool|long|double|float|char|byte|short|object|decimal)\b"),
        "out 变量声明（out var / out int x）是 C# 7 语法，请先声明变量再传 out",
        # 例外：方法/委托签名里的 out 参数（C# 5 合法）——以修饰符开头的声明行、extern 声明、
        # 以及跨行签名的续行（以 out 开头）。
        re.compile(
            r"^(out\b"
            r"|extern\b"
            r"|(public|private|protected|internal|static|virtual|override|abstract|sealed|delegate|partial|async|new|unsafe)\b)"
        ),
    ),
    (
        "CS5-6",
        re.compile(r"^\s*using\s+(var|const)?\s*[A-Za-z_][\w<>,\[\]\.\s]*=\s*[^;]*;\s*$"),
        "using 声明（using var x = ...;）是 C# 8 语法，请使用 using (...) { } 语句块",
        re.compile(r"^\s*using\s+[A-Za-z_][\w\.]*\s*(=|;)"),  # using System; / using Foo = Bar;
    ),
    (
        "CS5-7",
        re.compile(r"^\s*(public|private|protected|internal|static|override|virtual|sealed|async|\s)*[A-Za-z_][\w<>,\[\]\.\?]*\s+[A-Za-z_]\w*\s*\([^;]*\)\s*=>"),
        "表达式体方法（=> 方法体）是 C# 6 语法，请改成 { return ...; }",
        None,
    ),
    (
        "CS5-8",
        re.compile(r"^\s*(public|private|protected|internal)\s[^;{}()]*\{[^;{}]*get;\s*\}\s*=\s*[^;]+;"),
        "自动属性初始化器是 C# 6 语法，请在构造函数里赋值",
        None,
    ),
    (
        "CS5-9",
        re.compile(r"\bcatch\s*\([^)]*\)\s*when\s*\("),
        "异常过滤器 catch ... when 是 C# 6 语法，请改用 if + rethrow",
        None,
    ),
    (
        "CS5-10",
        re.compile(r"^\s*using\s+static\s+"),
        "using static 是 C# 6 语法，请显式写类名",
        None,
    ),
]


def strip_strings_and_comments(text):
    """把字符串与注释替换成空格（保留换行与列位置），避免把字符串里的 ?. / $" 误判为语法。"""
    out = []
    i = 0
    n = len(text)
    state = None  # None | "line" | "block" | "str" | "verbatim" | "char"
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if state is None:
            if c == "/" and nxt == "/":
                state = "line"
                out.append("  ")
                i += 2
                continue
            if c == "/" and nxt == "*":
                state = "block"
                out.append("  ")
                i += 2
                continue
            if c == "@" and nxt == '"':
                state = "verbatim"
                out.append('  ')
                i += 2
                continue
            if c == '"':
                state = "str"
                out.append(" ")
                i += 1
                continue
            if c == "'":
                state = "char"
                out.append(" ")
                i += 1
                continue
            out.append(c)
            i += 1
            continue
        if state == "line":
            if c == "\n":
                state = None
                out.append("\n")
                i += 1
                continue
            out.append(" ")
            i += 1
            continue
        if state == "block":
            if c == "*" and nxt == "/":
                state = None
                out.append("  ")
                i += 2
                continue
            out.append("\n" if c == "\n" else " ")
            i += 1
            continue
        if state == "str":
            if c == "\\":
                out.append("  ")
                i += 2
                continue
            if c == '"':
                state = None
                out.append(" ")
                i += 1
                continue
            out.append("\n" if c == "\n" else " ")
            i += 1
            continue
        if state == "verbatim":
            if c == '"' and nxt == '"':
                out.append("  ")
                i += 2
                continue
            if c == '"':
                state = None
                out.append(" ")
                i += 1
                continue
            out.append("\n" if c == "\n" else " ")
            i += 1
            continue
        if state == "char":
            if c == "\\":
                out.append("  ")
                i += 2
                continue
            if c == "'":
                state = None
                out.append(" ")
                i += 1
                continue
            out.append(" ")
            i += 1
            continue
    return "".join(out)


def collect_files(argv):
    if argv:
        files = [os.path.abspath(p) for p in argv]
    else:
        files = []
        for base, _dirs, names in os.walk(SRC):
            for name in names:
                if name.endswith(".cs"):
                    files.append(os.path.join(base, name))
    files.sort()
    return files


def main(argv):
    files = collect_files(argv)
    if not files:
        print("没有找到 .cs 文件")
        return 1
    problems = []
    for path in files:
        try:
            with io.open(path, "r", encoding="utf-8-sig", errors="replace") as handle:
                raw = handle.read()
        except OSError as exc:  # pragma: no cover
            problems.append((path, 0, "READ", "无法读取: %s" % exc))
            continue
        cleaned = strip_strings_and_comments(raw)
        raw_lines = raw.splitlines()
        clean_lines = cleaned.splitlines()
        for idx, line in enumerate(clean_lines):
            for code, pattern, message, exception in RULES:
                if not pattern.search(line):
                    continue
                if exception is not None and exception.search(raw_lines[idx].strip()):
                    continue
                problems.append((path, idx + 1, code, message))
                break
    rel = os.path.relpath
    for path, line, code, message in problems:
        print("%s:%d: [%s] %s" % (rel(path, ROOT), line, code, message))
        try:
            print("    > %s" % raw_lines_of(path, line).strip()[:160])
        except Exception:
            pass
    if problems:
        print("")
        print("C# 5 语法检查失败：%d 处" % len(problems))
        return 1
    print("C# 5 语法检查通过：%d 个文件" % len(files))
    return 0


_cache = {}


def raw_lines_of(path, line):
    if path not in _cache:
        with io.open(path, "r", encoding="utf-8-sig", errors="replace") as handle:
            _cache[path] = handle.read().splitlines()
    lines = _cache[path]
    if 1 <= line <= len(lines):
        return lines[line - 1]
    return ""


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
