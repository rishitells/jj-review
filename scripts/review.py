#!/usr/bin/env python3
"""Renders jj changes as one review page: each change's description, then every file it touches as a diff.

    review.py [-R repo] [revset] [--no-open]

With no revset it shows the changes from the working copy down to the nearest ancestor that has a bookmark (or
trunk), so a stack under review reads from its base. Changes without a diff (an empty working copy) are left out. Each file links to
your editor: Zed by default, or GUIDED_REVIEW_EDITOR (for example 'vscode://file/{path}').
"""
import argparse
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

GENERATED = [re.compile(p) for p in (
    r"\.generated\.", r"\.gen\.", r"(^|/)generated/", r"\.snap$",
    r"(^|/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum|Cargo\.lock|poetry\.lock)$",
)]

LANGS = {
    ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx", ".js": "javascript", ".mjs": "javascript",
    ".cjs": "javascript", ".jsx": "jsx", ".gql": "graphql", ".graphql": "graphql", ".graphqls": "graphql", ".json": "json",
    ".go": "go", ".py": "python", ".rb": "ruby", ".rs": "rust", ".java": "java", ".kt": "kotlin", ".swift": "swift",
    ".css": "css", ".scss": "scss", ".html": "html", ".md": "markdown", ".yml": "yaml", ".yaml": "yaml", ".toml": "toml",
    ".sh": "bash", ".sql": "sql", ".proto": "proto", ".tf": "hcl",
}

# A file bigger than this is shown collapsed, uncoloured, and can't grow: GitHub's "large diff" rule.
LARGE = 100_000


def is_large(fd):
    return sum(len(l) + 1 for l in fd.head_lines) > LARGE or sum(len(l) + 1 for l in fd.base_lines) > LARGE


RANGES = r"\d+(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*"


class ReviewError(Exception):
    pass


# ---------------------------------------------------------------------------------------------------------- jj


def jj(repo, *args):
    where = ["-R", repo] if repo else []
    return subprocess.run(["jj", *where, "--no-pager", "--color=never", *args], capture_output=True, text=True, check=True).stdout


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




def read_change(gitdir, ch):
    """A change's diff and description, with any count that disagrees with git."""
    lines = ch["description"].strip().split("\n")
    files = {f["path"]: FileDiff(gitdir, ch["parent"], ch["commit"], f) for f in read_diff(gitdir, ch["parent"], ch["commit"])}
    counted = numstat(gitdir, ch["parent"], ch["commit"])
    errors = []
    for path in sorted(set(counted) | set(files)):
        fd = files.get(path)
        got = "missing from the diff" if fd is None else (None if fd.binary and not fd.hunks else (len(fd.added), len(fd.dels)))
        if counted.get(path, "missing from numstat") != got:
            errors.append(f"{path}: git diff --numstat says {counted.get(path)}, the page would show {got}")
    return {**ch, "subject": lines[0] or "(no description)", "body": "\n".join(lines[1:]).strip(), "files": files, "errors": errors}


def shown_ranges(fd):
    """The new-file lines each hunk shows, context included; touching hunks join."""
    spans = []
    for h in fd.hunks:
        news = [l["new"] for l in h["lines"] if l["new"] is not None]
        if news:
            spans.append(f"{min(news)}-{max(news)}")
    return parse_ranges(",".join(spans)) if spans else []


def build_change(c, part, file_texts, open_attrs):
    """One change's files as HTML sections, and its index rows."""
    sections, toc = [], []
    for fi, path in enumerate(sorted(c["files"]), 1):
        fd, fid = c["files"][path], f"c{part}-f{fi}"
        ranges = shown_ranges(fd)
        if not fd.hunks:
            body = f'<p class="file-note">{"Binary file" if fd.binary else f"Mode {fd.mode}" if fd.mode else f"Empty file, {fd.status}"}</p>'
        elif not fd.head_lines or not ranges:
            body = "".join(hunk_listing(fd, h) for h in fd.hunks)
        elif is_large(fd):
            body = f'<details class="rest-file"><summary><span class="path">Large file, {len(fd.head_lines)} lines: show the diff</span></summary>{listing(fd, ranges, [], "", "")}</details>'
        else:
            key = f"{part}:{fi}"
            file_texts[key] = {"lines": fd.head_html, "added": sorted(fd.added), "dels": [[d["after"], fd.old_html(d["old"])] for d in fd.dels]}
            body = listing(fd, ranges, [], key, "")
        stat = f'<span class="add">+{len(fd.added)}</span> <span class="del">&minus;{len(fd.dels)}</span>'
        sections.append(
            f'<section class="chapter file" id="{fid}"><div class="step"><div class="step-head"><span class="path">{html.escape(path)}</span>'
            f'<span class="fstat">{stat}</span>{open_attrs(path)}<span class="lines"></span>'
            f'<label class="read"><input type="checkbox" data-read="{fid}"> Viewed</label></div>{body}</div></section>'
        )
        toc.append((fid, path, stat))
    return sections, toc


# ------------------------------------------------------------------------------------------------------ page

FOLDER_ICON = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1.75 2.5h4.2c.3 0 .58.13.77.36l.9 1.14h6.63c.41 0 .75.34.75.75v8.5c0 .41-.34.75-.75.75H1.75A.75.75 0 0 1 1 13.25V3.25c0-.41.34-.75.75-.75Z"/></svg>'
FILE_ICON = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" d="M3.5 1.75h6l3 3v9.5h-9z M9.5 1.75v3h3"/></svg>'
CHEVRON = '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="m6 4 4 4-4 4"/></svg>'
CHECK = '<svg class="check" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="m3.5 8.5 3 3 6-7"/></svg>'


def file_tree(files):
    """A change's files as a folder tree, GitHub style: folders first, then files, by name; a folder with one folder
    and nothing else inside joins it on one row ("services/web/src")."""
    root = {}
    for fid, path, stat in files:
        node = root
        *dirs, name = path.split("/")
        for d in dirs:
            node = node.setdefault(("d", d), {})
        node[("f", name)] = (fid, path, stat)

    def join(name, node):
        while len(node) == 1 and next(iter(node))[0] == "d":
            ((_, sub), child), = node.items()
            name, node = f"{name}/{sub}", child
        return name, node

    def render(node):
        out = []
        for (kind, name), child in sorted(node.items(), key=lambda kv: (kv[0][0] != "d", kv[0][1].lower())):
            if kind == "d":
                name, child = join(name, child)
                out.append(
                    f'<li class="dir"><details open><summary>{CHEVRON}{FOLDER_ICON}<span class="t">{html.escape(name)}</span></summary>'
                    f'<ul>{render(child)}</ul></details></li>'
                )
            else:
                fid, path, stat = child
                out.append(
                    f'<li class="file" data-path="{html.escape(path.lower())}"><a href="#{fid}" title="{html.escape(path)}">'
                    f'{FILE_ICON}{CHECK}<span class="t">{html.escape(name)}</span><span class="c">{stat}</span></a></li>'
                )
        return "".join(out)

    return render(root)



def highlight(changes):
    items = []
    for i, c in enumerate(changes):
        for fd in c["files"].values():
            if is_large(fd):
                continue
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
    editor = os.environ.get("GUIDED_REVIEW_EDITOR") or "zed://file/{path}"
    editor_name = os.environ.get("GUIDED_REVIEW_EDITOR_NAME") or urlsplit(editor).scheme.capitalize()

    def open_attrs(path):
        local = Path(workspace) / path
        if not local.is_file():
            return ""
        quoted = quote(str(local.resolve()), safe="/$+@:,;=!*'()&-._~")
        url = editor.replace("/{path}", "/" + quoted.lstrip("/")) if "/{path}" in editor else editor.replace("{path}", quoted)
        return (f'<a class="open-file" href="{html.escape(url)}" title="Open in {html.escape(editor_name)}">'
                f'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5h4v4"/><path d="M13.5 2.5 8 8"/><path d="M11.5 9.5v4h-9v-9h4"/></svg>'
                f'Open in {html.escape(editor_name)}</a>')

    body_html, toc_html, file_texts, overview = [], [], {}, []
    adds = dels = nfiles = 0
    for part, c in enumerate(changes, 1):
        sections, toc = build_change(c, part, file_texts, open_attrs)
        a = sum(len(fd.added) for fd in c["files"].values())
        d = sum(len(fd.dels) for fd in c["files"].values())
        adds, dels, nfiles = adds + a, dels + d, nfiles + len(c["files"])
        pid = f"c{part}"
        body_html.append(
            f'<section class="change" id="{pid}"><p class="eyebrow">Change {part} of {len(changes)} &middot; <code>{c["change"]}</code> &middot; commit <code>{c["commit"][:8]}</code></p>'
            f'<h2 class="title">{html.escape(c["subject"])}</h2><div class="summary">{md(c["body"])}</div>'
            f'<p class="stats"><span><b>{len(c["files"])}</b> files</span><span class="add"><b>+{a}</b></span><span class="del"><b>&minus;{d}</b></span></p></section>'
        )
        body_html.extend(sections)
        toc_html.append(
            f'<li class="part"><details open><summary><span class="n">{part}</span><span class="t">{html.escape(c["subject"])}</span></summary>'
            f'<a class="part-link" href="#{pid}">Description</a><ul class="tree">{file_tree(toc)}</ul></details></li>'
        )
        overview.append(
            f'<li><a href="#{pid}"><span class="n">{part}</span><span class="t">{html.escape(c["subject"])}</span>'
            f'<span class="c"><span class="add">+{a}</span> <span class="del">&minus;{d}</span></span></a></li>'
        )

    head = changes[-1]
    page = (ROOT / "template.html").read_text()
    replacements = {
        "{{TITLE}}": html.escape(f"Review: {head['subject'] if len(changes) == 1 else f'{Path(workspace).name}, {len(changes)} changes'}"),
        "{{EYEBROW}}": f"jj &middot; <code>{html.escape(revset)}</code> &middot; {html.escape(Path(workspace).name)}",
        "{{HEADING}}": f"{len(changes)} {'change' if len(changes) == 1 else 'changes'}",
        "{{OVERVIEW}}": "".join(overview),
        "{{FILES}}": str(nfiles), "{{ADDS}}": str(adds), "{{DELS}}": str(dels),
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
    print(f"{out}: {len(changes)} change(s), {nfiles} files", file=sys.stderr)
    return out


# ------------------------------------------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("revset", nargs="?", default="heads(::@- & (trunk() | bookmarks()))..@")
    ap.add_argument("-R", "--repository", help="the workspace root of another repository (default: the one you're in)")
    ap.add_argument("--no-open", action="store_true", help="write the page without opening it")
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
    problems = [f"{c['change']} {e}" for c in changes for e in c["errors"]]
    if problems:
        sys.exit("The diff reading disagrees with git, so no page was written:\n" + "\n".join(problems))
    out = render(repo, args.revset, changes, workspace)
    if not args.no_open:
        subprocess.run(["open" if sys.platform == "darwin" else "xdg-open", str(out)])


if __name__ == "__main__":
    main()
