"""Reads a git diff between two commits into files, hunks and lines.

Each line has a kind (ctx, add, del), its old and new numbers, and its text. Each file also says how it changed
(added, deleted, modified), whether it's binary, and whether its mode changed, so a file that changed without any text
lines is still accounted for.
"""
import re
import subprocess

HUNK = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def git(repo, *args):
    """Runs git against a git directory: a jj repository's backing store works, colocated or not."""
    # Leniently decoded: a binary file, or text that isn't UTF-8, mustn't stop the build.
    out = subprocess.run(["git", f"--git-dir={repo}", *args], capture_output=True, check=True).stdout
    return out.decode("utf-8", errors="replace")


def read_diff(repo, base, head, context=3):
    out = git(repo, "diff", f"-U{context}", "--no-color", "--no-renames", base, head)
    files, cur, hunk, old, new = [], None, None, 0, 0
    for raw in out.split("\n"):
        if raw.startswith("diff --git "):
            cur = {"path": raw.split(" b/", 1)[1], "hunks": [], "binary": False, "status": "modified", "mode": None}
            files.append(cur)
            hunk = None
        elif cur is None:
            continue
        elif hunk is None and raw.startswith("new file mode"):
            cur["status"] = "added"
        elif hunk is None and raw.startswith("deleted file mode"):
            cur["status"] = "deleted"
        elif hunk is None and raw.startswith("old mode "):
            cur["mode"] = raw[len("old mode "):]
        elif hunk is None and raw.startswith("new mode "):
            cur["mode"] = f'{cur["mode"]} → {raw[len("new mode "):]}'
        elif raw.startswith("Binary files"):
            cur["binary"] = True
        elif m := HUNK.match(raw):
            old, new = int(m[1]), int(m[2])
            hunk = {"lines": []}
            cur["hunks"].append(hunk)
        elif hunk is not None and raw[:1] in (" ", "+", "-") and not raw.startswith(("+++", "---")):
            kind = {" ": "ctx", "+": "add", "-": "del"}[raw[0]]
            # A Windows line ending isn't part of the line, as on GitHub.
            text = raw[1:].removesuffix("\r")
            hunk["lines"].append({"kind": kind, "old": old if kind != "add" else None, "new": new if kind != "del" else None, "text": text})
            if kind != "add":
                old += 1
            if kind != "del":
                new += 1
    return files


def numstat(repo, base, head):
    """Added and removed line counts per file, as git counts them; None for a binary file."""
    counts = {}
    for row in git(repo, "diff", "--numstat", "--no-renames", base, head).splitlines():
        adds, dels, path = row.split("\t", 2)
        counts[path] = None if adds == "-" else (int(adds), int(dels))
    return counts


def file_at(repo, rev, path):
    try:
        return [line.removesuffix("\r") for line in git(repo, "show", f"{rev}:{path}").split("\n")]
    except subprocess.CalledProcessError:
        return []


if __name__ == "__main__":
    import sys

    repo, base, head = sys.argv[1:4]
    skip = re.compile(sys.argv[4]) if len(sys.argv) > 4 else None
    for f in read_diff(repo, base, head):
        if skip and skip.search(f["path"]):
            continue
        print(f"=== {f['path']}")
        for h in f["hunks"]:
            print("  @@")
            for l in h["lines"]:
                mark = {"ctx": " ", "add": "+", "del": "-"}[l["kind"]]
                num = l["new"] if l["new"] is not None else f"({l['old']})"
                print(f"{mark}{str(num):>6} {l['text']}")
