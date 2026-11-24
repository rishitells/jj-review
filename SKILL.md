---
name: guided-review
description: "Render jj changes as one review page: each change's description, then every file it touches as a diff, with a link to open the file in an editor. Use when asked to show, review or look over jj changes, a stack, a bookmark or a revset as a page."
---

# Review page for jj changes

`$GR/scripts/review.py` (Python 3.10+, no packages) renders jj changes as one page, like a pull request's files: an
overview of the changes, then each change in stack order with its description and every file it touches. A file shows
its diff with its path pinned while it scrolls, an "Open in" link to your editor, and a Viewed box. Gaps between hunks
open on click, 20 lines at a time or to the whole file. The code and the counts come from git; nothing is written by
hand.

`$GR` is this skill's directory.

```bash
python3 $GR/scripts/review.py                      # from the working copy down to the nearest bookmark or trunk
python3 $GR/scripts/review.py 'trunk()..@'         # the whole stack
python3 $GR/scripts/review.py @-                   # one change
python3 $GR/scripts/review.py -R <repo> --no-open  # another repository; write the page without opening it
```

The page goes to `~/.cache/guided-review/` (or `$GUIDED_REVIEW_DIST`) and opens in the browser. Changes without a diff
are left out. The script refuses to write a page whose line counts differ from `git diff --numstat`.

- **Editor:** files open in Zed by default. Set `GUIDED_REVIEW_EDITOR`, for example `vscode://file/{path}` or
  `cursor://file/{path}`. The link opens the file in the working copy, which may differ from the change shown.
- **Colouring:** run `npm ci` in `$GR/scripts` once for Shiki. Without it the page builds uncoloured.
- **Large files:** a file over 100 KB is collapsed and uncoloured, as on GitHub.
- **Privacy:** the page carries the full text of every file it shows. Share it only where that code may go.

As a jj command, add an alias to your jj config (`jj config edit --user`):

```toml
[aliases]
review = ["util", "exec", "--", "python3", "<$GR>/scripts/review.py"]
```

Then `jj review`, or `jj review 'trunk()..@'`.
