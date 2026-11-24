---
name: guided-review
description: "Serve jj changes as a live review page: the changes on the left, and for the one you pick its description, a file tree and every file's diff, with links that open files in an editor. The page follows the repository as jj records operations. Use when asked to show, review or look over jj changes, a stack, a bookmark or a revset as a page."
---

# Live review page for jj changes

`$GR/scripts/review.py` serves jj changes as a review page on a local port, opens it, and keeps it current until you
stop it with Ctrl-C. `$GR` is this skill's directory.

- **Left:** the picked change's files as a tree ([@pierre/trees](https://diffs.com)) with git status and search, and
  under it the changes as a chain, newest at the top as in `jj log`, each with its change id (shortest unique prefix
  set off) and subject. The picked change opens in place: its full subject, commit, counts and description. The tree
  sits above the chain so its rows stay put when another change opens.
  Viewed files carry a tick, and a count sits under the tree. A "Live" badge turns to "Reconnecting" when the server
  stops. The divider resizes the sidebar and the width is remembered.
- **Right:** a slim bar with the picked change's id, commit and counts and the display toggles, then every file's diff
  ([@pierre/diffs](https://diffs.com)): single or split view (single by default), word-level changes, sticky file
  headers, and folded unchanged lines that open on click. Clicking a file in the tree scrolls to it.
- **Per file:** "Viewed" folds the file and stays until that file's diff changes, even when the change is rewritten.
  "Open in" opens the file in your editor, and a line number opens it at that line (a removed line opens the file at
  the top).
- **Display:** Wrap lines and Expand all (every unchanged line shown), remembered with the single or split choice.

The code comes from git through jj: each change against its first parent. Nothing on the page is written by hand.

## Live

The server checks jj's operation log every second, without touching the working copy. When an operation lands (a
`describe`, `squash`, `new`, rebase, or another person's or agent's commit), the page reads the changes again and
updates in place: only files whose diff changed are redrawn, and the picked change, scroll, Viewed and display stay.

- **Saved edits need jj's watchman trigger.** jj records file edits (snapshots the working copy) only when a jj
  command runs, so by default a save shows up after the next jj command. jj can record them as they're saved instead,
  with watchman and its snapshot trigger. It's a per-repository setting, so each repository needs it once:

  ```bash
  brew install watchman
  jj config set --repo fsmonitor.backend watchman
  jj config set --repo fsmonitor.watchman.register-snapshot-trigger true
  jj debug watchman status   # "Background snapshotting is currently active."
  ```

  With it, a save reaches the page in about a second. `review.py` checks the setting at startup and prints these
  steps when it's off, and the Live badge's tooltip says which mode the page is in. The jj docs warn that watchman
  can strain on very large repositories. Starting the server records the working copy once either way.
- Other workspaces share the operation log, so their commands make the page look again; nothing changes on it unless
  this range changed.
- Nothing is written to disk. The page is built in memory and the data is read from jj on request. Each run gets a
  free port (`GUIDED_REVIEW_PORT` picks one).

## Run it

```bash
python3 $GR/scripts/review.py                      # from the working copy down to the nearest bookmark or trunk
python3 $GR/scripts/review.py 'trunk()..@'         # the whole stack
python3 $GR/scripts/review.py @-                   # one change
python3 $GR/scripts/review.py -R <repo> --no-open  # another repository's workspace root; don't open the browser
```

Changes without a diff are left out. With none in the range, the page says so and fills in when some appear.

## Setup

Run `npm ci` in `$GR/scripts` once. The first run bundles the page's script (React, @pierre/diffs, @pierre/trees,
react-resizable-panels) with esbuild into `scripts/bundle.js`, and rebuilds it when `app.jsx` or the lockfile change.
That bundle is the only file the skill keeps. Code is highlighted with the library's "highlights" engine, which keeps
switching between changes instant.

- **Editor:** files open in Zed. Set `GUIDED_REVIEW_EDITOR`, for example `vscode://file/{path}` or
  `cursor://file/{path}`. The link opens the file in the working copy, which may differ from the change shown.
- **Network:** the server listens on 127.0.0.1 only and serves both versions of every file in the range.

## As a jj command

Add an alias to your jj config (`jj config edit --user`):

```toml
[aliases]
review = ["util", "exec", "--", "python3", "<$GR>/scripts/review.py"]
```

Then `jj review`, `jj review @-` or `jj review 'trunk()..@'` from anywhere in the repository.

## Files

- `scripts/review.py` reads the changes with jj and git, serves the page, its data and the change stream.
- `scripts/diff.py` reads a git diff into files and hunks, for the counts and file statuses.
- `scripts/app.jsx` is the page: the change list, the tree, the diffs, and the live updates.
- `scripts/page.html` holds the page's shell and its Fresh styles: Fixel (`font.css`, SIL Open Font License 1.1) for
  text, JetBrains Mono for code.
