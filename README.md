# jj-review

`jj review` serves jj changes as a review page on a local port, opens it, and keeps it current until you stop it with
Ctrl-C.

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
- **Theme:** a dropdown at the foot of the sidebar picks the diffs' theme, a light and dark pair: Pierre (the
  default) and its variants, warm ones (Gruvbox, Rosé Pine, Dawnfox, Everforest, Kanagawa, Solarized, Horizon) and
  cool or neutral ones (JetBrains and JetBrains Islands, Nightfox and Nordfox among them). A switch on top picks the
  mode: System (follows the computer), Light or Dark. The page takes the theme's background and keeps its own text.
  Both are remembered.

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
- Nothing is written to disk but the page's script (below). The page is built in memory and the data is read from jj
  on request. Each run gets a free port (`JJ_REVIEW_PORT` picks one).

## Run it

```bash
jj review                       # from the working copy down to the nearest bookmark or trunk
jj review 'trunk()..@'          # the whole stack
jj review @-                    # one change
jj review -R <repo> --no-open   # another repository's workspace root; don't open the browser
```

Changes without a diff are left out. With none in the range, the page says so and fills in when some appear.

## Setup

Clone this repository, run `npm ci` in it once, and add an alias to your jj config (`jj config edit --user`), with
the path to your clone:

```toml
[aliases]
review = ["util", "exec", "--", "python3", "/path/to/jj-review/server/review.py"]
```

Then `jj review` works from anywhere in any repository. Without the alias, `python3 server/review.py` takes the same
arguments.

The first run bundles the page's script (React, @pierre/diffs, @pierre/trees, react-resizable-panels) with esbuild
into `build/bundle.js`, and rebuilds it when the page's code, its themes or the lockfile change. That bundle is the
only file it writes. Code is highlighted with the library's "highlights" engine, which keeps switching between
changes instant.

- **Editor:** files open in Zed. Set `JJ_REVIEW_EDITOR`, for example `vscode://file/{path}` or
  `cursor://file/{path}`. The link opens the file in the working copy, which may differ from the change shown.
- **Network:** the server listens on 127.0.0.1 only and serves both versions of every file in the range.

## Files

- `server/review.py` reads the changes with jj and git, serves the page, its data and the change stream.
- `server/diff.py` reads a git diff into files and hunks, for the counts and file statuses.
- `web/app.jsx` is the page: the change list, the tree, the diffs, the theme picker, and the live updates.
- `web/page.html` holds the page's shell and its Fresh styles: Fixel (`font.css`, SIL Open Font License 1.1) for
  text, JetBrains Mono for code.
- `web/themes/themes.js` lists the themes the picker offers, each pair with the colours of its preview.
- `web/themes/jetbrains/` and `web/themes/nightfox/` hold themes that don't ship with Pierre, copied from Zed
  extensions with their licences: JetBrains (Apache 2.0, zed-theme-jetbrains) and the Nightfox family (MIT,
  nightfox.zed).
- `tests/fuzz.mjs` is the fuzz test (below).

## Testing

`tests/fuzz.mjs` builds a scratch jj repository, starts the server on it and opens the page in headless Chromium
(Playwright, a dev dependency: `npm ci` installs it; `npx playwright install chromium` once if no browser is cached).
It then applies random jj operations: new changes, inserts before and after, rewording, file edits inside any change,
squash, abandon, reordering (with the conflicts that brings), moving the base bookmark, empty changes and undo. Files
get awkward contents (unicode, tabs, CRLF, very long lines, no final newline, empty, binary, `</script>`) and awkward
paths (spaces, ` b/` inside a path, quotes, backslashes, tabs). After every operation it checks the server's data
against jj and git (changes, order, files, statuses, counts, contents), that the open page follows without a reload,
and that Viewed holds until a file's diff changes.

```bash
node tests/fuzz.mjs --cases 300            # a random seed, printed first
node tests/fuzz.mjs --seed 42 --cases 300 --keep     # replay a run exactly; keep the repository
```

`PYTHON=…` picks the interpreter for `review.py`. A failure names its seed and case; `--keep-going` reports every
failing case instead of stopping at the first. A case takes about two seconds, mostly waiting for the live page
to catch up, so 150 cases take about five minutes. One run at a time: it drives a browser and many jj commands.
