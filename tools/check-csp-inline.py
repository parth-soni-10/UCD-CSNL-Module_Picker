#!/usr/bin/env python3
"""Fail if anything in the served markup or generated HTML would be blocked by
our own Content-Security-Policy.

    python3 tools/check-csp-inline.py

The deployed policy is `script-src 'self'` / `style-src 'self'`, with neither
'unsafe-inline' nor a hash. An inline <script>, an inline event handler
(`on*="…"`) or a `style="…"` attribute therefore works perfectly on localhost —
where server.js sends no CSP at all — and is silently dropped in production.

That is not hypothetical: the service-worker registration used to live in an
inline <script>, so it never ran on the deployed site while working locally, and
the only trace was a console violation nobody was reading.

JS files are scanned too, because most of this app's markup is generated from
template strings. A line whose code (comments stripped) contains style="…" is a
real violation; a mention inside a comment is not.

The functions under netlify/functions/ are scanned for the same reason: the
suggestions endpoint answers a form navigation with a page it builds itself, so
the markup of that page lives in a JS template string and would be dropped in
production the same way an inline <script> in index.html is.
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# <script> with no src, and on*= attributes.
INLINE_SCRIPT = re.compile(r"<script(?![^>]*\bsrc=)[^>]*>", re.I)
INLINE_HANDLER = re.compile(r"\son(?:click|change|input|submit|load|error|focus|blur|keydown|keyup|mouseover|mouseout|touchstart)\s*=", re.I)
STYLE_ATTR = re.compile(r"style\s*=\s*[\"']")
LINE_COMMENT = re.compile(r"//.*$")


def strip_comments(line):
    line = LINE_COMMENT.sub("", line)
    stripped = line.strip()
    if stripped.startswith("*") or stripped.startswith("/*"):
        return ""
    return line


def scan(path, label):
    problems = []
    with open(path, encoding="utf-8") as fh:
        for number, line in enumerate(fh, 1):
            code = strip_comments(line) if path.endswith(".js") else line
            if not code:
                continue
            for pattern, what in (
                (INLINE_SCRIPT, "inline <script>"),
                (INLINE_HANDLER, "inline event handler"),
                (STYLE_ATTR, 'style="\u2026" attribute'),
            ):
                if pattern.search(code):
                    problems.append((number, what, code.strip()[:100]))
    return [(label, n, what, snippet) for n, what, snippet in problems]


def main():
    targets = []
    functions = os.path.join(ROOT, "netlify", "functions")
    scanned = ["index.html", "app.js", "sw.js"]
    if os.path.isdir(functions):
        scanned += [
            os.path.join("netlify", "functions", name)
            for name in sorted(os.listdir(functions))
            if name.endswith(".js")
        ]
    for rel in scanned:
        path = os.path.join(ROOT, rel)
        if os.path.exists(path):
            targets.append((path, rel))

    problems = []
    for path, rel in targets:
        problems.extend(scan(path, rel))

    if problems:
        print("CSP would block %d construct(s):\n" % len(problems))
        for rel, number, what, snippet in problems:
            print("  %s:%d  %s\n      %s" % (rel, number, what, snippet))
        print(
            "\nEither move it into a file/class, or add its hash to the policy in "
            "_headers."
        )
        return 1

    print("OK \u2014 no inline script, handler or style attribute the CSP would block")
    return 0


if __name__ == "__main__":
    sys.exit(main())
