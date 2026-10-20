#!/usr/bin/env python3
"""Fail if anything in the served markup or generated HTML would be blocked by
our own Content-Security-Policy.

    python3 tools/check-csp-inline.py

The deployed policy is `script-src 'self'` / `style-src 'self'`, with neither
'unsafe-inline' nor a hash. An executable inline <script>, an inline event handler
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

import json
import os
import re
import sys
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# <script> with no src, and on*= attributes.
INLINE_SCRIPT = re.compile(r"<script(?![^>]*\bsrc=)(?![^>]*\btype=[\"']application/ld\+json[\"'])[^>]*>", re.I)
JSON_LD_SCRIPT = re.compile(r"<script\b[^>]*\btype=[\"']application/ld\+json[\"'][^>]*>(.*?)</script\s*>", re.I | re.S)
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

    # JSON-LD is a non-executable data block, allowed by browsers under
    # script-src 'self'. Parse it so a markup exception cannot hide bad data.
    index_path = os.path.join(ROOT, "index.html")
    with open(index_path, encoding="utf-8") as fh:
        index_html = fh.read()
    for number, match in enumerate(JSON_LD_SCRIPT.finditer(index_html), 1):
        try:
            json.loads(match.group(1))
        except json.JSONDecodeError as error:
            line = index_html.count("\n", 0, match.start(1)) + 1
            problems.append(("index.html", line, "invalid JSON-LD", str(error)))

    class Scripts(HTMLParser):
        def __init__(self):
            super().__init__()
            self.external = []

        def handle_starttag(self, tag, attrs):
            if tag.lower() == "script":
                attrs = dict(attrs)
                if attrs.get("src"):
                    self.external.append(attrs["src"])

    scripts = Scripts()
    scripts.feed(index_html)
    # EVERY external script must be same-origin, and there must be at least one.
    # This used to say "exactly one same-origin external script", which was
    # written when the page loaded exactly one — and the Hairline figure added
    # three more (its kernel, its mount and its orbit). Checking the COUNT
    # instead of the ORIGIN meant a second script from anywhere would have
    # been reported as a count problem rather than as the origin problem it
    # actually is. So the rule is now the stronger one: every one of them is
    # checked, and a page that loads nothing is still reported.
    if not scripts.external:
        problems.append(
            ("index.html", 1, "script-count", "no external script — the page loads nothing")
        )
    for src in scripts.external:
        if not src or src.startswith(("//", "http:", "https:")):
            problems.append(
                (
                    "index.html",
                    1,
                    "script-origin",
                    "external script %r is not a same-origin path (absolute or relative URL)" % src,
                )
            )

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
