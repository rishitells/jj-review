---
name: jj-review
description: "Open Jujutsu (jj) changes in jj-review, a live local review page, picking the revset from what the user describes (this stack, a ticket's bookmark, everything on main, changes touching a path). Use when asked to review, show or open jj changes as a page, or to start or stop jj review."
---

# jj-review

`jj review [revset]` serves the changes as a review page on localhost and follows the repository live until stopped.
The user reads the page; you choose what's on it.

Turn what they describe into a revset, the same language as `jj log -r`. With no argument it shows the stack they're
in. Otherwise reach for whatever fits: `trunk():: ~ trunk()` for everything on main, `bookmarks(substring:"H2-160")`
for a ticket, `mine()`, `files("…")`, `description(substring:"…")`, `committer_date(…)`, joined with `&` and `|`.
Check it with `jj log -r` first so the page shows what they meant, and tell them the revset you used.

Run it in the background from their workspace; it opens the browser and prints the URL. Running the same review
again just reopens it. If `jj review` isn't set up, the server is `../server/review.py` from this skill's folder.
