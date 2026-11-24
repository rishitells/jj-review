---
name: guided-review
description: "Render jj changes as one review page: the changes on the left, and for the one you pick its description, a file tree and every file's diff, with links that open files in an editor. Use when asked to show, review or look over jj changes, a stack, a bookmark or a revset as a page."
---

# Review page for jj changes

`$GR/scripts/review.py` renders jj changes as one page and opens it. `$GR` is this skill's directory.

- **Left:** the changes in stack order, each with its change id (shortest unique prefix set off, as in `jj log`) and
  subject, then the picked change's files as a tree ([@pierre/trees](https://diffs.com)) with git status and search.
  Viewed files carry a tick, and a count sits under the tree. The divider resizes the sidebar and the width is
  remembered.
- **Right:** the picked change's id, commit, counts and description, then every file's diff
  ([@pierre/diffs](https://diffs.com)): single or split view (single by default), word-level changes, sticky file
  headers, and folded unchanged lines that open on click. Clicking a file in the tree scrolls to it.
- **Per file:** "Viewed" folds the file and is remembered per commit, so a change that moves on starts unviewed
  again. "Open in" opens the file in your editor, and a line number opens it at that line (a removed line opens the
  file at the top).
- **Display:** Wrap lines and Expand all (every unchanged line shown), remembered with the single or split choice.

The code comes from git through jj: each change against its first parent. Nothing on the page is written by hand.

## Run it

```bash
python3 $GR/scripts/review.py                      # from the working copy down to the nearest bookmark or trunk
python3 $GR/scripts/review.py 'trunk()..@'         # the whole stack
python3 $GR/scripts/review.py @-                   # one change
python3 $GR/scripts/review.py -R <repo> --no-open  # another repository's workspace root; write without opening
```

The page goes to `~/.cache/guided-review/` (or `$GUIDED_REVIEW_DIST`). Changes without a diff are left out.

## Setup

Run `npm ci` in `$GR/scripts` once. The first run bundles the page's script (React, @pierre/diffs, @pierre/trees,
react-resizable-panels) with esbuild into `scripts/bundle.js`, and rebuilds it when `app.jsx` or the lockfile change.
The bundle is about 12 MB and every page carries it. Code is highlighted with the library's "highlights" engine, which keeps switching between changes instant.

- **Editor:** files open in Zed. Set `GUIDED_REVIEW_EDITOR`, for example `vscode://file/{path}` or
  `cursor://file/{path}`. The link opens the file in the working copy, which may differ from the change shown.
- **Privacy:** the page carries both versions of every file it shows. Share it only where that code may go.

## As a jj command

Add an alias to your jj config (`jj config edit --user`):

```toml
[aliases]
review = ["util", "exec", "--", "python3", "<$GR>/scripts/review.py"]
```

Then `jj review`, `jj review @-` or `jj review 'trunk()..@'` from anywhere in the repository.

## Files

- `scripts/review.py` reads the changes with jj and git, writes the page.
- `scripts/diff.py` reads a git diff into files and hunks, for the counts and file statuses.
- `scripts/app.jsx` is the page: the change list, the tree, the diffs.
- `scripts/page.html` holds the page's shell and its Fresh styles: Fixel (`font.css`, SIL Open Font License 1.1) for
  text, JetBrains Mono for code.
