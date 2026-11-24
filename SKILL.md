---
name: guided-review
description: "Write review notes into each jj change's description, check them against the diff, and render the changes as one review page. Use when describing a jj change someone will review, before pushing or opening a PR from jj changes, and when asked for a guided review or review page of jj changes, a bookmark or a revset."
---

# Guided review in jj descriptions

Each change carries its own review notes in its description: for each file it touches, notes on the lines that need
saying. A script checks the notes against the change's diff and renders the changes as one page, like a pull
request's files: every file's diff, its path pinned while it scrolls, and the notes beside the lines they name. The
code and the line numbers come from git; only the notes are yours.

`$GR` below is this skill's directory. The script is `$GR/scripts/review.py` (Python 3.10+, no packages).

## The format

The description is the subject, the body, then a `Review:` block:

```
Chat: show up to 7 shown entries inline

Short lists the agent finds show in the answer, with each entry's status and the facts the question asked about.

Review:
src/chat/form-panel.tsx
  617-621: **Check:** the one rule both callers use: 1 to 7 entries show in the conversation.

src/chat/conversation.tsx
  385-389: An entries part draws the list itself when it is short.
  717-742: Reads status and facts when the list is drawn, so they are current.
    A deeper-indented line continues the note.
  700-712,730: A note can name several ranges.
```

- A path on its own line, from the repository root, starts a file.
- Each indented `ranges: text` line under it is a note. Line numbers are the file's as this change leaves it, the
  numbers `jj diff` shows on the right. A note's lines must sit inside one stretch of the diff as the page shows it:
  the changed lines and the three lines of context around them.
- `code` and `**bold**` work. Start a note with `**Check:**` for what a reviewer should look at closely.

## Writing the notes

Write the block when you describe a change, after its code has settled. Line numbers belong to the change, so rewrite
the block after any edit to the change.

1. Read the change's diff with new line numbers:
   `python3 $GR/scripts/diff.py "$(jj git root)" <commit>~ <commit>`. Each line shows its new number, and a removed
   line shows its old number in brackets.
2. Give every changed file at least one note. Generated files and lockfiles are exempt. A file whose change is
   obvious gets one short note ("Imports for the new read.").
3. Say what the lines do and why, not what they say. Name the rule behind a behaviour when there is one. Flag with
   `**Check:**` a behaviour change that's easy to miss, an assumed edge case, or a mismatch with the ticket.
4. Verify every claim against the code. If you can't confirm a reason, leave the reason out.
5. Write plainly: subject, verb, object, present tense, the code as it is now.

## Check, then render

```bash
python3 $GR/scripts/review.py check 'trunk()..@'            # exit 1 on any problem, named by change and line
python3 $GR/scripts/review.py render 'trunk()..@' --open     # writes and opens the page
python3 $GR/scripts/review.py render 'trunk()..my-bookmark'  # a stack under a bookmark
```

`-R <path>` points at another repository. Changes without a diff are left out, so an empty working copy is fine.

`check` fails a change when:

- its description has no Review block, or a line of the block doesn't parse;
- a file in the block isn't touched by the change, or is listed without notes;
- a changed file (other than a generated file or lockfile) has no note;
- a note names lines outside the diff's stretches, or spans two of them;
- the page's line counts differ from `git diff --numstat` of the change against its parent.

Run `check` on every change you describe, and get it passing before `jj git push` or `gh pr create`. Never work around
a failure. Fix the line numbers, or add the note.

`render` writes one page to `~/.cache/guided-review/` (or `$GUIDED_REVIEW_DIST`). The page starts with an overview of
the changes. Then each change follows in stack order: its subject and description, then every file it touches, in
path order. A diff opens 20 lines at a time or to the whole file, and each file has a Viewed box. A file over 100 KB
is collapsed and uncoloured, as on GitHub. The page carries the full text of every file it shows, so share it only
where that code may go.

Code is coloured with Shiki when its packages are installed. Run `npm ci` in `$GR/scripts` once. Without them the
page still builds, uncoloured, and says so. Set `GUIDED_REVIEW_EDITOR='zed://file/{path}'` (or `vscode://file/{path}`)
to give each file a link that opens it.

## Before a PR

A squash-merging repository keeps only the PR body on its main branch. Write the PR body from the change's subject and
body, without the Review block, and give the reviewer the rendered page.
