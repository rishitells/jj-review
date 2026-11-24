"""Parses a git-format diff (jj diff --git) into files, hunks and lines.

Each line has a kind (ctx, add, del), its old and new numbers, and its text. Each file also says how it changed
(added, deleted, modified), whether it's binary, and whether its mode changed, so a file that changed without any text
lines is still accounted for.
"""
import re

HUNK = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@")


ESCAPES = {"a": "\a", "b": "\b", "t": "\t", "n": "\n", "v": "\v", "f": "\f", "r": "\r", '"': '"', "\\": "\\"}


def unquote(quoted):
    """A path git wrote as a C string ("a/x\\ty"): its bytes, decoded."""
    out, i, body = bytearray(), 0, quoted[1:-1]
    while i < len(body):
        c = body[i]
        if c == "\\" and body[i + 1 : i + 4].isdigit() and len(body[i + 1 : i + 4]) == 3:
            out.append(int(body[i + 1 : i + 4], 8))
            i += 4
        elif c == "\\" and i + 1 < len(body):
            out.extend(ESCAPES.get(body[i + 1], body[i + 1]).encode())
            i += 2
        else:
            out.extend(c.encode())
            i += 1
    return out.decode("utf-8", errors="replace")


def header_path(line):
    """The path in a "diff --git a/<path> b/<path>" line. Without renames both sides are the same path, so it's half of
    what follows: no split on " b/" can go wrong, whatever the path holds. Paths git had to quote come quoted."""
    rest = line[len("diff --git "):]
    if rest.startswith('"'):
        end = 1
        while rest[end] != '"':
            end += 2 if rest[end] == "\\" else 1
        return unquote(rest[: end + 1])[2:]
    return rest[2 : 2 + (len(rest) - 5) // 2]


def parse_diff(out):
    """A git-format diff (git's or jj's) as files. A rename or copy names both paths: `path` is the new one and
    `old_path` the one it came from."""
    files, cur, hunk, old, new = [], None, None, 0, 0
    for raw in out.split("\n"):
        if raw.startswith("diff --git "):
            cur = {"path": header_path(raw), "hunks": [], "binary": False, "status": "modified", "mode": None}
            files.append(cur)
            hunk = None
        elif cur is None:
            continue
        elif hunk is None and raw.startswith(("rename from ", "copy from ")):
            cur["old_path"] = raw.split(" from ", 1)[1]
            cur["status"] = "renamed" if raw.startswith("rename") else "copied"
        elif hunk is None and raw.startswith(("rename to ", "copy to ")):
            cur["path"] = raw.split(" to ", 1)[1]
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
        # Inside a hunk every line counts, even one that starts "+++" or "---" (a conflict marker, a "--flag"): the
        # file headers come before the first hunk, and "diff --git" ends the hunk.
        elif hunk is not None and raw[:1] in (" ", "+", "-"):
            kind = {" ": "ctx", "+": "add", "-": "del"}[raw[0]]
            # A Windows line ending isn't part of the line, as on GitHub.
            text = raw[1:].removesuffix("\r")
            hunk["lines"].append({"kind": kind, "old": old if kind != "add" else None, "new": new if kind != "del" else None, "text": text})
            if kind != "add":
                old += 1
            if kind != "del":
                new += 1
    return files
