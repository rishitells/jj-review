#!/usr/bin/env python3
"""Shows jj changes as a review page that follows the repository live.

    review.py [-R repo] [revset] [--no-open]

With no revset it shows the changes from the working copy down to the nearest ancestor that has a bookmark (or
trunk). Changes without a diff (an empty working copy) are left out. The page lists the changes; picking one shows its
description, its files as a tree and every file's diff (@pierre/diffs, single or split). Each file opens in your
editor: Zed unless GUIDED_REVIEW_EDITOR says otherwise (for example 'vscode://file/{path}').

It serves the page on a local port and keeps it current: whenever a jj command records an operation (describe,
squash, new, a rebase, someone else's commit), the page updates in place. Edits jj hasn't recorded yet show up after
the next jj command. Nothing is written to disk; Ctrl-C stops it.

The page's script is bundled with esbuild the first time, and again when app.jsx or the packages change, so run
`npm ci` in this folder once.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from diff import file_at, read_diff

ROOT = Path(__file__).parent
BUNDLE = ROOT / "bundle.js"
DEFAULT_REVSET = "heads(::@- & (trunk() | bookmarks()))..@"


def jj(repo, *args, snapshot=True):
    """Runs jj. Without snapshot it never touches the working copy, so it can't race the user's own commands."""
    where = ["-R", repo] if repo else []
    quiet = [] if snapshot else ["--ignore-working-copy"]
    return subprocess.run(
        ["jj", *where, *quiet, "--no-pager", "--color=never", *args], capture_output=True, text=True, check=True
    ).stdout


def changes_in(repo, revset, snapshot=True):
    """The revset's changes with a diff, bottom of the stack first."""
    sep = "\x1f"
    template = (
        f'change_id.short(8) ++ "{sep}" ++ change_id.shortest(8).prefix() ++ "{sep}" ++ commit_id ++ "{sep}" ++ '
        f'parents.map(|c| c.commit_id()).join(",") ++ "{sep}" ++ if(empty, "1", "0") ++ "{sep}" ++ description ++ "\\x1e"'
    )
    out = jj(repo, "log", "--no-graph", "--reversed", "-r", revset, "-T", template, snapshot=snapshot)
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
        old = "" if f["status"] == "added" else "\n".join(file_at(gitdir, c["parent"], f["path"]))
        new = "" if f["status"] == "deleted" else "\n".join(file_at(gitdir, c["commit"], f["path"]))
        files.append({
            "path": f["path"],
            "status": f["status"],
            "binary": f["binary"],
            "old": old,
            "new": new,
            # Names this exact diff: a file stays viewed until its diff changes.
            "sig": hashlib.sha1(f"{old}\0{new}".encode("utf-8", "replace")).hexdigest()[:16],
            "adds": kinds.count("add"),
            "dels": kinds.count("del"),
        })
    return {
        "change": c["change"], "prefix": c["prefix"], "commit": c["commit"],
        "subject": lines[0] or "(no description)", "body": "\n".join(lines[1:]).strip(), "files": files,
    }


class Review:
    """The changes to show, read again when asked; a change whose commit didn't move is reused."""

    def __init__(self, repo, revset, snapshot):
        self.repo, self.revset, self.snapshot = repo, revset, snapshot
        self.workspace = jj(repo, "workspace", "root", snapshot=snapshot).strip()
        self.gitdir = jj(repo, "git", "root", snapshot=snapshot).strip()
        self.by_commit = {}
        editor = os.environ.get("GUIDED_REVIEW_EDITOR") or "zed://file/{path}"
        self.settings = {
            "workspace": self.workspace,
            "repo": Path(self.workspace).name,
            "revset": revset,
            "editor": editor,
            "editorName": os.environ.get("GUIDED_REVIEW_EDITOR_NAME") or urlsplit(editor).scheme.capitalize(),
        }

    def data(self):
        changes = []
        for c in changes_in(self.repo, self.revset, snapshot=self.snapshot):
            if c["commit"] not in self.by_commit:
                self.by_commit[c["commit"]] = read_change(self.gitdir, c)
            changes.append(self.by_commit[c["commit"]])
        live = {c["commit"] for c in changes}
        self.by_commit = {k: v for k, v in self.by_commit.items() if k in live}
        return {**self.settings, "changes": changes}

    def operation(self):
        return jj(self.repo, "op", "log", "-n1", "--no-graph", "-T", "id.short(16)", snapshot=False).strip()


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


def page(title):
    """The page shell: the bundled app, which asks the server for its data."""
    out = (ROOT / "page.html").read_text()
    for key, value in {
        "{{TITLE}}": title,
        "{{FONT_CSS}}": (ROOT / "font.css").read_text(),
        "{{BUNDLE}}": bundle().replace("</script", "<\\/script"),
    }.items():
        out = out.replace(key, value)
    return out


def open_in_browser(target):
    subprocess.run(["open" if sys.platform == "darwin" else "xdg-open", target])


def serve(review, no_open):
    """Serves the page, its data, and a stream that says when jj recorded a new operation. Nothing is written to disk:
    the page is built in memory and the data is read from jj on each request."""
    # Record the working copy once, as any jj command would, so edits made before starting show up.
    jj(review.repo, "log", "--no-graph", "-r", "@", "-T", '""')
    state = {"op": review.operation()}
    lock = threading.Lock()

    def watch():
        while True:
            time.sleep(1)
            try:
                op = review.operation()
            except subprocess.CalledProcessError:
                continue  # jj busy or mid-operation: look again next second
            state["op"] = op

    threading.Thread(target=watch, daemon=True).start()
    shell = page("Review: " + review.settings["repo"])

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, status, kind, body):
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == "/":
                self.send(200, "text/html; charset=utf-8", shell.encode())
            elif path == "/data":
                try:
                    with lock:
                        body = json.dumps({**review.data(), "op": state["op"]}).encode()
                    self.send(200, "application/json", body)
                except subprocess.CalledProcessError as err:
                    self.send(503, "text/plain", f"jj failed: {err.stderr.strip()}".encode())
            elif path == "/events":
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                seen, quiet = None, 0
                try:
                    while True:
                        if state["op"] != seen:
                            seen, quiet = state["op"], 0
                            self.wfile.write(f"event: change\ndata: {seen}\n\n".encode())
                            self.wfile.flush()
                        elif quiet >= 30:
                            quiet = 0
                            self.wfile.write(b": still here\n\n")
                            self.wfile.flush()
                        time.sleep(0.5)
                        quiet += 1
                except (BrokenPipeError, ConnectionResetError):
                    return
            else:
                self.send(404, "text/plain", b"not found")

    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("GUIDED_REVIEW_PORT", "0"))), Handler)
    server.daemon_threads = True
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"Reviewing {review.revset} in {review.settings['repo']} at {url} (live; Ctrl-C stops it)", file=sys.stderr)
    if not no_open:
        open_in_browser(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("revset", nargs="?", default=DEFAULT_REVSET)
    ap.add_argument("-R", "--repository", help="the workspace root of another repository (default: the one you're in)")
    ap.add_argument("--no-open", action="store_true", help="don't open the browser")
    args = ap.parse_intermixed_args()
    try:
        serve(Review(args.repository, args.revset, snapshot=False), args.no_open)
    except subprocess.CalledProcessError as err:
        sys.exit(f"jj failed: {err.stderr.strip()}")


if __name__ == "__main__":
    main()
