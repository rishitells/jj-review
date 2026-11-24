#!/usr/bin/env python3
"""Renders jj changes as one review page, and opens it.

    review.py [-R repo] [revset] [--no-open]

With no revset it shows the changes from the working copy down to the nearest ancestor that has a bookmark (or
trunk). Changes without a diff (an empty working copy) are left out. The page lists the changes; picking one shows its
description, its files as a tree and every file's diff (@pierre/diffs, single or split). Each file opens in your
editor: Zed unless GUIDED_REVIEW_EDITOR says otherwise (for example 'vscode://file/{path}').

The page's script is bundled with esbuild the first time, and again when app.jsx or the packages change, so run
`npm ci` in this folder once.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

from diff import file_at, read_diff

ROOT = Path(__file__).parent
BUNDLE = ROOT / "bundle.js"
DEFAULT_REVSET = "heads(::@- & (trunk() | bookmarks()))..@"


def jj(repo, *args):
    where = ["-R", repo] if repo else []
    return subprocess.run(["jj", *where, "--no-pager", "--color=never", *args], capture_output=True, text=True, check=True).stdout


def changes_in(repo, revset):
    """The revset's changes with a diff, bottom of the stack first."""
    sep = "\x1f"
    template = (
        f'change_id.short(8) ++ "{sep}" ++ change_id.shortest(8).prefix() ++ "{sep}" ++ commit_id ++ "{sep}" ++ '
        f'parents.map(|c| c.commit_id()).join(",") ++ "{sep}" ++ if(empty, "1", "0") ++ "{sep}" ++ description ++ "\\x1e"'
    )
    out = jj(repo, "log", "--no-graph", "--reversed", "-r", revset, "-T", template)
    changes = []
    for row in out.split("\x1e"):
        if not row.strip():
            continue
        change, prefix, commit, parents, empty, description = row.lstrip("\n").split(sep, 5)
        if empty != "1":
            changes.append({"change": change, "prefix": prefix, "commit": commit, "parent": parents.split(",")[0], "description": description})
    return changes


def read_change(gitdir, c):
    lines = c["description"].strip().split("\n")
    files = []
    for f in read_diff(gitdir, c["parent"], c["commit"]):
        kinds = [l["kind"] for h in f["hunks"] for l in h["lines"]]
        files.append({
            "path": f["path"],
            "status": f["status"],
            "binary": f["binary"],
            "old": "" if f["status"] == "added" else "\n".join(file_at(gitdir, c["parent"], f["path"])),
            "new": "" if f["status"] == "deleted" else "\n".join(file_at(gitdir, c["commit"], f["path"])),
            "adds": kinds.count("add"),
            "dels": kinds.count("del"),
        })
    return {
        "change": c["change"], "prefix": c["prefix"], "commit": c["commit"],
        "subject": lines[0] or "(no description)", "body": "\n".join(lines[1:]).strip(), "files": files,
    }


def bundle():
    """The page's script, rebuilt when its sources are newer than the last build."""
    sources = [ROOT / "app.jsx", ROOT / "package-lock.json"]
    if BUNDLE.exists() and BUNDLE.stat().st_mtime >= max(s.stat().st_mtime for s in sources):
        return BUNDLE.read_text()
    esbuild = ROOT / "node_modules" / ".bin" / "esbuild"
    if not esbuild.exists():
        sys.exit(f"The page's packages aren't installed: run `npm ci` in {ROOT}")
    subprocess.run(
        [str(esbuild), "app.jsx", "--bundle", "--format=iife", "--jsx=automatic", "--minify", "--log-level=warning",
         '--define:process.env.NODE_ENV="production"', f"--outfile={BUNDLE.name}"],
        cwd=ROOT, check=True,
    )
    return BUNDLE.read_text()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("revset", nargs="?", default=DEFAULT_REVSET)
    ap.add_argument("-R", "--repository", help="the workspace root of another repository (default: the one you're in)")
    ap.add_argument("--no-open", action="store_true", help="write the page without opening it")
    args = ap.parse_intermixed_args()

    try:
        workspace = jj(args.repository, "workspace", "root").strip()
        gitdir = jj(args.repository, "git", "root").strip()
        changes = [read_change(gitdir, c) for c in changes_in(args.repository, args.revset)]
    except subprocess.CalledProcessError as err:
        sys.exit(f"jj failed: {err.stderr.strip()}")
    if not changes:
        sys.exit(f"no changes with a diff in {args.revset}")

    editor = os.environ.get("GUIDED_REVIEW_EDITOR") or "zed://file/{path}"
    data = {
        "workspace": workspace,
        "repo": Path(workspace).name,
        "revset": args.revset,
        "editor": editor,
        "editorName": os.environ.get("GUIDED_REVIEW_EDITOR_NAME") or urlsplit(editor).scheme.capitalize(),
        "changes": changes,
    }
    # Escaped so no file's text can close the script tag it sits in.
    payload = json.dumps(data, separators=(",", ":")).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    script = bundle().replace("</script", "<\\/script")
    n = len(changes)
    title = changes[-1]["subject"] if n == 1 else f"{data['repo']}, {n} changes"
    page = (ROOT / "page.html").read_text()
    for key, value in {
        "{{TITLE}}": f"Review: {title}",
        "{{FONT_CSS}}": (ROOT / "font.css").read_text(),
        "{{DATA}}": payload,
        "{{BUNDLE}}": script,
    }.items():
        page = page.replace(key, value)

    out_dir = Path(os.environ.get("GUIDED_REVIEW_DIST") or Path.home() / ".cache" / "guided-review")
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{data['repo']}-{changes[-1]['change']}.html"
    out.write_text(page)
    print(f"{out}: {n} {'change' if n == 1 else 'changes'}, {sum(len(c['files']) for c in changes)} files", file=sys.stderr)
    if not args.no_open:
        subprocess.run(["open" if sys.platform == "darwin" else "xdg-open", str(out)])


if __name__ == "__main__":
    main()
