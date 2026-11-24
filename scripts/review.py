#!/usr/bin/env python3
"""Checks and renders guided reviews written in jj change descriptions.

    review.py check  [-R repo] [revset]     exit 1 unless every change's Review block is complete and correct
    review.py render [-R repo] [revset] [--open]   write one page for the changes, bottom of the stack first

The revset defaults to 'trunk()..@'. Changes without a diff (an empty working copy) are left out.

A change's description is its subject, its body, then a Review block:

    Review:
    ## Chapter title
    One or two sentences on what the chapter covers.

    path/to/file.ts:12-30, 88-95
      14-18: What these lines do and why. `code` and **bold** work.
        A deeper-indented line continues the note.
      20,24-26: A note can name several ranges.

    Skip: path/or/glob/* -- why a reader doesn't need these lines

Paths are from the repository root, and line numbers are the change's own: the file as the change leaves it. Every
changed line must sit in a step, match a Skip, or fall in a group the page files by itself (tests, generated files,
translations, import blocks). The page's code and counts come from git; the chapters and notes are the author's.
"""
import argparse
import fnmatch
import html
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote, urlsplit

from diff import file_at, git, numstat, read_diff

ROOT = Path(__file__).parent

GROUPS = {
    "Tests": [r"\.(test|spec)\.", r"(^|/)(tests?|__tests__|spec|e2e)/", r"_test\.(go|py)$", r"(^|/)test_[^/]+\.py$"],
    "Generated": [r"\.generated\.", r"\.gen\.", r"(^|/)generated/", r"\.snap$", r"(^|/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum|Cargo\.lock|poetry\.lock)$"],
    "Translations": [r"(^|/)locales?/", r"(^|/)i18n/", r"\.po$"],
}
GROUP_PATTERNS = {k: [re.compile(p) for p in v] for k, v in GROUPS.items()}

GROUP_NOTES = {
    "Skipped": "The change's description skips these, for the reason beside each.",
    "Tests": "Filed here by path. Open anything that doesn't look like a test.",
    "Generated": "Filed here by path. Open anything that doesn't look generated.",
    "Translations": "Filed here by path.",
    "Imports": "Filed here because every changed line sits in the import block at the top of its file.",
    "Changed without lines": "These files changed, but git shows no text lines for them.",
    "Not in the tour": "Code the review doesn't walk through.",
}

LANGS = {
    ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx", ".js": "javascript", ".mjs": "javascript",
    ".cjs": "javascript", ".jsx": "jsx", ".gql": "graphql", ".graphql": "graphql", ".graphqls": "graphql", ".json": "json",
    ".go": "go", ".py": "python", ".rb": "ruby", ".rs": "rust", ".java": "java", ".kt": "kotlin", ".swift": "swift",
    ".css": "css", ".scss": "scss", ".html": "html", ".md": "markdown", ".yml": "yaml", ".yaml": "yaml", ".toml": "toml",
    ".sh": "bash", ".sql": "sql", ".proto": "proto", ".tf": "hcl",
}

RANGES = r"\d+(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*"
STEP = re.compile(rf"^(\S+?):({RANGES})\s*$")
NOTE = re.compile(rf"^\s+({RANGES}):\s+(.*)$")
SKIP = re.compile(r"^Skip:\s+(\S+)\s+(?:--|—|–)\s+(.+)$")


class ReviewError(Exception):
    pass


# ---------------------------------------------------------------------------------------------------------- jj


def jj(repo, *args):
    return subprocess.run(["jj", "-R", repo, "--no-pager", "--color=never", *args], capture_output=True, text=True, check=True).stdout


def changes_in(repo, revset):
    """The revset's changes, bottom of the stack first: change id, commit id, first parent's commit id, description."""
    sep = "\x1f"
    template = f'change_id.short(8) ++ "{sep}" ++ commit_id ++ "{sep}" ++ parents.map(|c| c.commit_id()).join(",") ++ "{sep}" ++ if(empty, "1", "0") ++ "\\x1e"'
    out = jj(repo, "log", "--no-graph", "--reversed", "-r", revset, "-T", template)
    changes = []
    for row in out.split("\x1e"):
        if not row.strip():
            continue
        change, commit, parents, empty = row.split(sep)
        if empty == "1":
            continue
        desc = jj(repo, "log", "--no-graph", "-r", commit, "-T", "description")
        changes.append({"change": change, "commit": commit, "parent": parents.split(",")[0], "description": desc})
    return changes


# --------------------------------------------------------------------------------------------- the description


def parse_description(text):
    """Subject, body and the Review block's chapters and skips. Errors name the description's line."""
    lines = text.rstrip("\n").split("\n")
    subject = lines[0].strip()
    start = next((i for i, l in enumerate(lines) if l.strip() == "Review:"), None)
    if start is None:
        return subject, "\n".join(lines[1:]).strip(), None, [], []
    body = "\n".join(lines[1:start]).strip()
    chapters, skips, errors = [], [], []
    ch = step = note = None
    for n, raw in enumerate(lines[start + 1:], start + 2):
        if not raw.strip():
            note = None
            if ch and not ch["steps"] and ch["intro"]:
                ch["intro"] += "\n\n"
            continue
        if raw.startswith("## "):
            ch = {"title": raw[3:].strip(), "intro": "", "steps": [], "line": n}
            chapters.append(ch)
            step = note = None
        elif m := SKIP.match(raw):
            skips.append({"pattern": m[1], "why": m[2].strip(), "line": n, "used": False})
            step = note = None
        elif ch is None:
            errors.append(f"line {n}: the Review block starts with a chapter (## Title) or a Skip: line")
        elif m := STEP.match(raw):
            step = {"file": m[1], "lines": m[2], "notes": [], "line": n}
            ch["steps"].append(step)
            note = None
        elif raw[0] in " \t":
            if step and (m := NOTE.match(raw)) and (note is None or len(raw) - len(raw.lstrip()) <= note["indent"]):
                note = {"lines": m[2 - 1], "text": m[2], "indent": len(raw) - len(raw.lstrip())}
                step["notes"].append(note)
            elif note:
                note["text"] += " " + raw.strip()
            else:
                errors.append(f"line {n}: an indented line is a note under a step, as '  12-18: text'")
        elif not ch["steps"]:
            ch["intro"] += (" " if ch["intro"] and not ch["intro"].endswith("\n\n") else "") + raw.strip()
        else:
            errors.append(f"line {n}: {raw.strip()!r} isn't a step (path:12-30), a note, a Skip: line or a ## chapter")
    for c in chapters:
        c["intro"] = c["intro"].strip()
        if not c["steps"]:
            errors.append(f"line {c['line']}: chapter {c['title']!r} has no steps")
        for s in c["steps"]:
            if not s["notes"]:
                errors.append(f"line {s['line']}: step {s['file']}:{s['lines']} has no notes")
    if not chapters:
        errors.append("the Review block has no chapters")
    return subject, body, chapters, skips, errors


# ------------------------------------------------------------------------------------------------- one change


def lang_of(path):
    return LANGS.get(Path(path).suffix, "text")


def keep_returns(lines):
    return [h.replace("\r", "&#13;") for h in lines]


def md(text):
    t = html.escape(text)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    t = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", t)
    return "".join(f"<p>{p.strip()}</p>" for p in t.split("\n\n") if p.strip())


def import_region(lines):
    region, inside = set(), False
    for n, line in enumerate(lines, 1):
        s = line.strip()
        if inside:
            region.add(n)
            if re.search(r"\bfrom\s+['\"]", s) or s.endswith(";"):
                inside = False
            continue
        if s.startswith("import ") or s == "" or s.startswith(("//", "/*", "*", "#!")) or re.fullmatch(r"['\"]use [a-z ]+['\"];?", s):
            region.add(n)
            if s.startswith("import ") and not re.search(r"\bfrom\s+['\"]|^import\s+['\"]", s):
                inside = True
            continue
        break
    return region


def trim(lines):
    return lines[:-1] if lines and lines[-1] == "" else lines


def l_new_before(hunk, line):
    prev = None
    for l in hunk["lines"]:
        if l is line:
            break
        if l["new"] is not None:
            prev = l["new"]
    if prev is not None:
        return prev
    first_new = next((l["new"] for l in hunk["lines"] if l["new"] is not None), None)
    return (first_new - 1) if first_new is not None else 0


class FileDiff:
    def __init__(self, gitdir, base, head, f):
        self.path = f["path"]
        self.hunks = f["hunks"]
        self.binary, self.status, self.mode = f["binary"], f["status"], f["mode"]
        self.head_lines = trim(file_at(gitdir, head, self.path))
        self.base_lines = trim(file_at(gitdir, base, self.path))
        self.added = {l["new"] for h in self.hunks for l in h["lines"] if l["kind"] == "add"}
        self.dels = []
        for h in self.hunks:
            after = None
            for l in h["lines"]:
                if l["kind"] == "del":
                    if after is None:
                        after = l_new_before(h, l)
                    self.dels.append({"after": after, "old": l["old"], "text": l["text"]})
                else:
                    after = l["new"]
        self.changed = len(self.added) + len(self.dels)
        self.head_imports = import_region(self.head_lines)
        self.base_imports = import_region(self.base_lines)
        self.head_html = keep_returns([html.escape(t) for t in self.head_lines])
        self.base_html = keep_returns([html.escape(t) for t in self.base_lines])

    def new_html(self, n):
        return self.head_html[n - 1] if 0 < n <= len(self.head_html) else ""

    def old_html(self, n):
        return self.base_html[n - 1] if 0 < n <= len(self.base_html) else ""

    def rows(self, a, b):
        out, by_after = [], {}
        for d in self.dels:
            by_after.setdefault(d["after"], []).append(d)
        for d in by_after.get(a - 1, []):
            out.append(("del", None, self.old_html(d["old"])))
        for n in range(a, b + 1):
            out.append(("add" if n in self.added else "ctx", n, self.new_html(n)))
            for d in by_after.get(n, []):
                out.append(("del", None, self.old_html(d["old"])))
        return out


def parse_range(spec):
    a, _, b = spec.partition("-")
    return int(a), int(b or a)


def parse_ranges(spec):
    ranges = []
    for a, b in sorted(parse_range(part.strip()) for part in str(spec).split(",")):
        if ranges and a <= ranges[-1][1] + 1:
            ranges[-1] = (ranges[-1][0], max(ranges[-1][1], b))
        else:
            ranges.append((a, b))
    return ranges


def format_ranges(ranges, dash="-"):
    return ", ".join(f"{a}{dash}{b}" if a != b else str(a) for a, b in ranges)


def listing(fd, ranges, notes, file_key, extra=""):
    rows = []
    for i, (a, b) in enumerate(ranges):
        if i:
            rows.append(("gap", f"{ranges[i - 1][1] + 1}-{a - 1}", ""))
        rows.extend(fd.rows(a, b))
    index_of_new, range_of_new, pre_lines = {}, {}, []
    for i, (kind, num, text) in enumerate(rows, 1):
        if kind != "gap" and num is not None:
            index_of_new[num] = i
        pre_lines.append(f'<span class="ln" data-k="{kind}">{num if num is not None else ""}</span>{text}')
    for r, (a, b) in enumerate(ranges):
        for n in range(a, b + 1):
            range_of_new[n] = r
    items = []
    for note in notes:
        specs = []
        for part in str(note["lines"]).split(","):
            x, y = parse_range(part.strip())
            if x not in index_of_new or y not in index_of_new or range_of_new[x] != range_of_new[y]:
                raise ReviewError(f"{fd.path}: note lines {part.strip()} must sit within one of the step's ranges {format_ranges(ranges)}")
            specs.append(f"{index_of_new[x]}-{index_of_new[y]}")
        items.append(f'<li data-lines="{",".join(specs)}">{md(note["text"])}</li>')
    a, b = ranges[0][0], ranges[-1][1]
    attrs = f'data-lang="{lang_of(fd.path)}" data-file="{file_key}" data-from="{a}" data-to="{b}" data-total="{len(fd.head_lines)}"{extra}'
    return f'<figure class="codenotes rv" {attrs}><pre class="code">{chr(10).join(pre_lines)}</pre><ol class="codenotes-notes">{"".join(items)}</ol></figure>'


def hunk_listing(fd, hunk):
    lines = []
    for l in hunk["lines"]:
        line = fd.old_html(l["old"]) if l["kind"] == "del" else fd.new_html(l["new"])
        lines.append(f'<span class="ln" data-k="{l["kind"]}">{l["new"] if l["new"] is not None else ""}</span>{line}')
    return f'<figure class="codenotes rv plain" data-lang="{lang_of(fd.path)}"><pre class="code">{chr(10).join(lines)}</pre><ol class="codenotes-notes"></ol></figure>'


def skip_matches(pattern, path):
    return path == pattern or fnmatch.fnmatch(path, pattern) or (pattern.endswith("/") and path.startswith(pattern))


def read_change(gitdir, ch):
    """A change's diff and parsed review, with every problem the check reports."""
    subject, body, chapters, skips, errors = parse_description(ch["description"])
    files = {f["path"]: FileDiff(gitdir, ch["parent"], ch["commit"], f) for f in read_diff(gitdir, ch["parent"], ch["commit"])}
    counted = numstat(gitdir, ch["parent"], ch["commit"])
    for path in sorted(set(counted) | set(files)):
        fd = files.get(path)
        got = "missing from the diff" if fd is None else (None if fd.binary and not fd.hunks else (len(fd.added), len(fd.dels)))
        if counted.get(path, "missing from numstat") != got:
            errors.append(f"{path}: git diff --numstat says {counted.get(path)}, the page would show {got}")
    if chapters is None:
        errors.append("no Review: block in the description")
    return {**ch, "subject": subject, "body": body, "chapters": chapters or [], "skips": skips, "files": files, "errors": errors}


def build_change(c, part, file_keys, file_texts, open_attrs):
    """One change's chapters and Everything else, as HTML, with its counts. Problems go into c["errors"]."""
    files, errors = c["files"], c["errors"]
    covered = {p: {"add": set(), "del": set()} for p in files}
    chapters_html, toc = [], []
    for ci, chap in enumerate(c["chapters"], 1):
        steps_html, ch_lines = [], 0
        for st in chap["steps"]:
            path, fd = st["file"], files.get(st["file"])
            where = f"line {st['line']}: {path}:{st['lines']}"
            if fd is None:
                errors.append(f"{where}: the change doesn't touch this file")
                continue
            ranges = parse_ranges(st["lines"])
            if ranges[0][0] < 1 or ranges[-1][1] > max(len(fd.head_lines), 1):
                errors.append(f"{where}: the file has {len(fd.head_lines)} lines after the change")
                continue
            if not any(a - 1 <= d["after"] <= b for a, b in ranges for d in fd.dels) and not any(a <= n <= b for a, b in ranges for n in fd.added):
                errors.append(f"{where}: no changed line in this range (stale line numbers?)")
            for a, b in ranges:
                for n in range(a, b + 1):
                    if n in fd.added and n not in covered[path]["add"]:
                        covered[path]["add"].add(n)
                        ch_lines += 1
                for di, d in enumerate(fd.dels):
                    if a - 1 <= d["after"] <= b and di not in covered[path]["del"]:
                        covered[path]["del"].add(di)
                        ch_lines += 1
            if path not in file_keys:
                key = file_keys[path] = f"{part}:{len(file_keys)}"
                file_texts[key] = {"lines": fd.head_html, "added": sorted(fd.added), "dels": [[d["after"], fd.old_html(d["old"])] for d in fd.dels]}
            try:
                figure = listing(fd, ranges, st["notes"], file_keys[path], open_attrs(path))
            except ReviewError as err:
                errors.append(f"line {st['line']}: {err}")
                continue
            head = f'<div class="step-head"><span class="path">{html.escape(path)}</span><span class="lines">{format_ranges(ranges, "&ndash;")}</span></div>'
            steps_html.append(f'<div class="step">{head}{figure}</div>')
        cid = f"c{part}-{ci}"
        toc.append((cid, chap["title"], ch_lines))
        chapters_html.append(
            f'<section class="chapter" id="{cid}"><div class="ch-head"><h2><span class="n">{{N}}</span>{html.escape(chap["title"])}</h2>'
            f'<label class="read"><input type="checkbox" data-read="{cid}"> Read</label></div>'
            f'<div class="ch-intro">{md(chap["intro"])}</div>{"".join(steps_html)}</section>'
        )

    groups = {"Not in the tour": [], "Skipped": [], "Tests": [], "Generated": [], "Translations": [], "Imports": []}
    rest_lines = {k: 0 for k in groups}

    def skip_of(path):
        for s in c["skips"]:
            if skip_matches(s["pattern"], path):
                s["used"] = True
                return s
        return None

    bare = []
    for path, fd in files.items():
        if not fd.hunks:
            bare.append((path, "binary" if fd.binary else f"mode {fd.mode}" if fd.mode else f"empty, {fd.status}"))
    reasons = {}
    for path, fd in files.items():
        group = next((k for k, ps in GROUP_PATTERNS.items() if any(p.search(path) for p in ps)), None)
        skip = skip_of(path)
        for h in fd.hunks:
            add_left = [l["new"] for l in h["lines"] if l["kind"] == "add" and l["new"] not in covered[path]["add"]]
            del_left = [l["old"] for l in h["lines"] if l["kind"] == "del" and next(i for i, d in enumerate(fd.dels) if d["old"] == l["old"]) not in covered[path]["del"]]
            if not add_left and not del_left:
                continue
            kind = "Skipped" if skip else group
            if kind is None:
                only_imports = all(n in fd.head_imports for n in add_left) and all(o in fd.base_imports for o in del_left)
                kind = "Imports" if only_imports else "Not in the tour"
            if kind == "Skipped":
                reasons[path] = skip["why"]
            if kind == "Not in the tour":
                span = format_ranges([(min(add_left), max(add_left))]) if add_left else f"removed lines after {l_new_before(h, h['lines'][0])}"
                errors.append(f"{path}:{span}: changed code that no step walks through and no Skip: covers")
            groups[kind].append((path, h, len(add_left) + len(del_left)))
            rest_lines[kind] += len(add_left) + len(del_left)
    for s in c["skips"]:
        if not s["used"]:
            errors.append(f"line {s['line']}: Skip: {s['pattern']} matches no file this change touches")

    rest_html = []
    if bare:
        rows = "".join(f'<li><span class="path">{html.escape(p)}</span><span class="count">{html.escape(w)}</span></li>' for p, w in bare)
        rest_html.append(f'<div class="rest-group"><h3>Changed without lines <span class="count">{len(bare)} files</span></h3><p class="rest-note">{GROUP_NOTES["Changed without lines"]}</p><ul class="bare">{rows}</ul></div>')
    for kind, items in groups.items():
        if not items:
            continue
        by_file, left_in = {}, {}
        for path, h, left in items:
            by_file.setdefault(path, []).append(h)
            left_in[path] = left_in.get(path, 0) + left
        files_html = []
        for path, hunks in by_file.items():
            body = "".join(hunk_listing(files[path], h) for h in hunks)
            shown = sum(1 for h in hunks for l in h["lines"] if l["kind"] != "ctx")
            plural = lambda n: f"{n} line" if n == 1 else f"{n} lines"
            count = plural(left_in[path]) if left_in[path] == shown else f"{left_in[path]} of {plural(shown)}"
            why = f'<p class="rest-note">{md(reasons[path])[3:-4]}</p>' if path in reasons else ""
            files_html.append(f'<details class="rest-file"><summary><span class="path">{html.escape(path)}</span><span class="count">{count}</span></summary>{why}{body}</details>')
        warn = ' class="warn"' if kind == "Not in the tour" else ""
        rest_html.append(f'<div class="rest-group"><h3{warn}>{kind} <span class="count">{rest_lines[kind]} changed lines in {len(by_file)} files</span></h3><p class="rest-note">{GROUP_NOTES[kind]}</p>{"".join(files_html)}</div>')

    rest_total = sum(rest_lines.values())
    if rest_html:
        rid = f"c{part}-rest"
        toc.append((rid, "Everything else", rest_total))
        chapters_html.append(
            f'<section class="chapter rest" id="{rid}"><div class="ch-head"><h2>Everything else</h2></div>'
            f'<div class="ch-intro"><p>Every changed line the review doesn\'t walk through, grouped by kind. Open a file to see its changes.</p></div>{"".join(rest_html)}</section>'
        )
    total = sum(fd.changed for fd in files.values())
    in_tour = sum(len(v["add"]) + len(v["del"]) for v in covered.values())
    return {
        "chapters_html": chapters_html, "toc": toc, "bare": len(bare), "total": total, "in_tour": in_tour,
        "adds": sum(len(fd.added) for fd in files.values()), "dels": sum(len(fd.dels) for fd in files.values()), "files": len(files),
    }


# ------------------------------------------------------------------------------------------------------ page


def highlight(changes):
    items = []
    for i, c in enumerate(changes):
        for fd in c["files"].values():
            if fd.head_lines:
                items.append({"id": f"{i}\n{fd.path}\nhead", "lang": lang_of(fd.path), "text": "\n".join(fd.head_lines)})
            if fd.dels and fd.base_lines:
                items.append({"id": f"{i}\n{fd.path}\nbase", "lang": lang_of(fd.path), "text": "\n".join(fd.base_lines)})
    try:
        done = subprocess.run(["node", str(ROOT / "highlight.mjs")], input=json.dumps({"items": items}), capture_output=True, text=True, check=True)
        out = json.loads(done.stdout)
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError) as err:
        detail = getattr(err, "stderr", "") or err
        print(f"warning: code isn't highlighted; run `npm ci` in {ROOT} once ({str(detail).strip()[:200]})", file=sys.stderr)
        return ""
    for i, c in enumerate(changes):
        for fd in c["files"].values():
            fd.head_html = keep_returns(out["lines"].get(f"{i}\n{fd.path}\nhead", fd.head_html))
            fd.base_html = keep_returns(out["lines"].get(f"{i}\n{fd.path}\nbase", fd.base_html))
    return out["css"]


def render(repo, revset, changes, workspace):
    css = highlight(changes)
    editor = os.environ.get("GUIDED_REVIEW_EDITOR", "")
    editor_name = os.environ.get("GUIDED_REVIEW_EDITOR_NAME") or urlsplit(editor).scheme.capitalize()

    def open_attrs(path):
        local = Path(workspace) / path
        if not editor or not local.is_file():
            return ""
        quoted = quote(str(local.resolve()), safe="/$+@:,;=!*'()&-._~")
        url = editor.replace("/{path}", "/" + quoted.lstrip("/")) if "/{path}" in editor else editor.replace("{path}", quoted)
        return f' data-open="{html.escape(re.sub(r"[:#]?L?{line}", "", url))}" data-open-name="{html.escape(editor_name)}"'

    stack = len(changes) > 1
    body_html, toc_html, sums, n = [], [], {"total": 0, "in_tour": 0, "adds": 0, "dels": 0, "files": 0, "bare": 0}, 0
    file_texts = {}
    for part, c in enumerate(changes, 1):
        built = build_change(c, part, {}, file_texts, open_attrs)
        c["adds"], c["dels"] = built["adds"], built["dels"]
        for k in sums:
            sums[k] += built[k]
        if stack:
            pid = f"c{part}"
            pct = f"{built['in_tour']} of {built['total']} changed lines walked through"
            body_html.append(
                f'<section class="change" id="{pid}"><p class="eyebrow">Change {part} of {len(changes)} &middot; <code>{c["change"]}</code></p>'
                f'<h2 class="title">{html.escape(c["subject"])}</h2><div class="summary">{md(c["body"])}</div>'
                f'<p class="stats"><span><b>{built["files"]}</b> files</span><span class="add"><b>+{built["adds"]}</b></span><span class="del"><b>&minus;{built["dels"]}</b></span><span>{pct}</span></p></section>'
            )
            toc_html.append(f'<li class="part"><a href="#{pid}">{part}. {html.escape(c["subject"])}</a></li>')
        for chap_html, (cid, title, lines) in zip(built["chapters_html"], built["toc"]):
            is_rest = cid.endswith("-rest")
            if not is_rest:
                n += 1
            body_html.append(chap_html.replace("{N}", str(n)))
            num = "" if is_rest else str(n)
            toc_html.append(f'<li><a href="#{cid}"><span class="n">{num}</span><span class="t">{html.escape(title)}</span><span class="c">{lines}</span></a></li>')

    head = changes[-1]
    if stack:
        rows = "".join(
            f'<li><a href="#c{i}"><span class="n">{i}</span><span class="t">{html.escape(c["subject"])}</span>'
            f'<span class="c"><span class="add">+{c["adds"]}</span> <span class="del">&minus;{c["dels"]}</span></span></a></li>'
            for i, c in enumerate(changes, 1)
        )
        heading = revset
        summary = f'<p>{len(changes)} changes, bottom of the stack first. Each reads on its own: its description, its chapters, then everything else it touches.</p><ol class="overview">{rows}</ol>'
        eyebrow = f"jj &middot; {len(changes)} changes &middot; head <code>{head['commit'][:8]}</code>"
    else:
        heading, summary = head["subject"], md(head["body"])
        eyebrow = f"jj &middot; <code>{head['change']}</code> &middot; commit <code>{head['commit'][:8]}</code>"
    total = sums["total"]
    page = (ROOT / "template.html").read_text()
    replacements = {
        "{{TITLE}}": html.escape(f"Review: {heading}"),
        "{{EYEBROW}}": eyebrow,
        "{{HEADING}}": html.escape(heading),
        "{{SUMMARY}}": summary,
        "{{BARE}}": f" {sums['bare']} files changed without text lines; they're listed too." if sums["bare"] else "",
        "{{FILES}}": str(sums["files"]), "{{ADDS}}": str(sums["adds"]), "{{DELS}}": str(sums["dels"]),
        "{{IN_TOUR}}": str(sums["in_tour"]), "{{TOTAL}}": str(total), "{{PCT}}": f"{100 * sums['in_tour'] / total:.0f}" if total else "0",
        "{{TOC}}": "".join(toc_html),
        "{{CHAPTERS}}": "".join(body_html),
        "{{STORE_KEY}}": json.dumps(f"guided-review:{head['commit'][:12]}"),
        "{{FONT_CSS}}": (ROOT / "font.css").read_text(),
        "{{SCRIPT}}": (ROOT / "reviewnotes.js").read_text(),
        "{{HL_CSS}}": css,
        "{{FILES_JSON}}": json.dumps(file_texts, separators=(",", ":")).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026"),
    }
    for k, v in replacements.items():
        page = page.replace(k, v)
    out_dir = Path(os.environ.get("GUIDED_REVIEW_DIST") or Path.home() / ".cache" / "guided-review")
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{Path(workspace).name}-{head['change']}.html"
    out.write_text(page)
    print(f"{out}: {sums['in_tour']} of {total} changed lines walked through, {len(changes)} change(s)", file=sys.stderr)
    return out


# ------------------------------------------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["check", "render"])
    ap.add_argument("revset", nargs="?", default="trunk()..@")
    ap.add_argument("-R", "--repository", default=".")
    ap.add_argument("--open", action="store_true", help="open the page in the default browser")
    args = ap.parse_intermixed_args()

    repo = args.repository
    try:
        workspace = jj(repo, "workspace", "root").strip()
        gitdir = jj(repo, "git", "root").strip()
        changes = [read_change(gitdir, c) for c in changes_in(repo, args.revset)]
    except subprocess.CalledProcessError as err:
        sys.exit(f"jj failed: {err.stderr.strip()}")
    if not changes:
        sys.exit(f"no changes with a diff in {args.revset}")

    if args.command == "render":
        out = render(repo, args.revset, changes, workspace)
        if args.open:
            subprocess.run(["open" if sys.platform == "darwin" else "xdg-open", str(out)])
    else:
        for i, c in enumerate(changes, 1):
            build_change(c, i, {}, {}, lambda p: "")

    failed = [c for c in changes if c["errors"]]
    for c in changes:
        mark = "FAIL" if c["errors"] else "ok  "
        print(f"{mark} {c['change']} {c['subject']}", file=sys.stderr)
        for e in c["errors"]:
            print(f"       {e}", file=sys.stderr)
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
