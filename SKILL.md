---
name: guided-review
description: "Write a guided review into each jj change's description, check it, and render it as a page. Use when describing a jj change someone will review, before pushing or opening a PR from jj changes, and when asked for a guided review, review tour or walkthrough of jj changes, a bookmark or a revset."
---

# Guided review in jj descriptions

A guided review orders a change by meaning, not by file name. Chapters run in the order you'd explain them, and each
step is a range of one file with notes beside the lines they explain. Here the review lives in the change's own
description, so it travels with the change, and a script checks it against the diff and renders it. You write the
notes. The script supplies the code, the counts and the page, and it checks your ranges.

`$GR` below is this skill's directory. The script is `$GR/scripts/review.py` (Python 3.10+, no packages).

## The format

The description is the subject, then the body, then a `Review:` block:

```
Chat: show up to 7 shown entries inline

Short lists the agent finds show in the answer with each entry's status and the facts the question asked about.

Review:
## Where the facts come from
The source reads a few fields for a few entries, so a row can say more than a title.

src/source/queries.ts:161-209
  161-170: Only scalar, enum and relation fields qualify, at most three, so the query stays small.
  185-209: **Check:** it reads the DRAFT stage, so a row shows unpublished edits.
    A deeper-indented line continues the note.

src/chat/conversation.tsx:385-389, 675-768
  385-389: The answer shows the list itself when it is short enough.
  700-712,730: A note can name several ranges.

Skip: docs/components.md -- regenerated from src/ui/docs.ts
```

- `## Title` starts a chapter. The lines under it, before its first step, are its intro.
- `path:ranges` starts a step. The path is from the repository root. The ranges are line numbers in the file as this
  change leaves it, and a step may name several ranges of one file (`20-26, 60-69`).
- An indented `ranges: text` line is a note on the step above it. A note's lines must sit inside one of the step's
  ranges. Deeper-indented lines continue the note. `code` and `**bold**` work.
- `Skip: <path or glob> -- <reason>` takes a file out of the walk-through. The page lists it under Everything else,
  with the reason beside it. Use it for regenerated files, fixtures and docs that mirror the code.
- Tests, generated files, lockfiles, translations and import blocks are filed under Everything else by themselves.
  They need no step and no Skip.

## Writing it

Write the Review block when you describe a change, after the code has settled. Line numbers belong to the change, so
rewrite the block after any edit to the change.

1. Read the change's diff: `jj diff --git -r <change>`.
2. Plan chapters by how the change works: where the data comes from, then what's built on it, then the callers,
   then the edges. A reader never meets a name before the chapter that introduces it. One idea per chapter. Titles
   name the thing ("Where the facts come from"), never a sentence or a pun.
3. Keep steps tight: the changed lines plus what a reader needs to place them. The page lets the reader grow any step
   or open the whole file.
4. Notes say what the lines do and why, not what they say. Name the rule behind a behaviour when there is one: a
   ticket, a spec section, an existing pattern. Start a note with `**Check:**` for what a reviewer should look at
   closely: a behaviour change that's easy to miss, an assumed edge case, a mismatch with the ticket. Verify every
   claim against the code. If you can't confirm a reason, leave the reason out.
5. Write plainly: subject, verb, object, present tense, the code as it is now.

## Check, then render

```bash
python3 $GR/scripts/review.py check 'trunk()..@'            # exit 1 on any problem, named by change and line
python3 $GR/scripts/review.py render 'trunk()..@' --open     # writes and opens the page
python3 $GR/scripts/review.py render 'trunk()..my-bookmark'  # a stack under a bookmark
```

`-R <path>` points at another repository. Changes without a diff are left out, so an empty working copy is fine.

`check` fails a change when:

- its description has no Review block, or the block doesn't parse;
- a step names a file the change doesn't touch, a range past the file's end, or a range with no changed line in it
  (usually stale line numbers);
- a note names lines outside its step;
- a changed line of code is in no step, no Skip and no automatic group;
- a Skip matches no file of the change;
- the page's line counts differ from `git diff --numstat` of the change against its parent.

Run `check` on every change you describe, and get it passing before `jj git push` or `gh pr create`. Never work
around a failure: fix the ranges, add the step, or Skip with a true reason.

`render` writes one page to `~/.cache/guided-review/` (or `$GUIDED_REVIEW_DIST`). A single change gets its own page.
A stack gets an overview of its changes, then each change in order with its description, chapters and Everything
else. The page carries the full text of every file a step shows, so share it only where that code may go.

Code is coloured with Shiki when its packages are installed. Run `npm ci` in `$GR/scripts` once. Without them the
page still builds, uncoloured, and says so. Set `GUIDED_REVIEW_EDITOR='zed://file/{path}'` (or `vscode://file/{path}`)
to give each step a link that opens its file.

## Before a PR

The repository may squash-merge, and then only the PR body reaches the main branch. Write the PR body from the
change's subject and body, without the Review block, and give the reviewer the rendered page.
