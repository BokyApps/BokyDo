# Working in this repo as an agent

Several agents work on BokyDo at the same time. This file is the short version of how to do that
without stepping on each other. It is deliberately on `main` so that every agent sees it.

**The board is Todoist** (project _BokyDo Plan_), not this file. Claim a task by moving it to
**In Progress** and commenting with your agent label and branch name; the live register of who is
doing what is `git branch -vv` plus that board. This document only covers the rules that keep
parallel work from breaking.

## Branch discipline

- **One branch per task**, named for it (`w10b-rest`, `w11e`). Push as soon as there is a commit —
  unpushed work is invisible, so to everyone else it looks like nothing is happening.
- **Do not commit on `main` from the shared checkout.** `main` is checked out in
  `/home/sarel/Documents/Code/BokyDo` and every agent shares it, so a commit there lands on top of
  whatever anyone else has staged. Work on a branch and merge deliberately.
  The exception is a change everyone needs immediately — a broken-gate fix or a document like this
  one. Land it, push it, and say so on the board.
- **Stage explicitly** (`git add <paths>`), never `git add -A`. On 2026-10-06 one agent's
  uncommitted A1 changes sat in `app.ts` and `docs/threat-model.md` for ~14 hours; a broad
  `git add` would have committed their half-finished work under someone else's message.
- **Do not leave the shared tree dirty.** `pnpm check` runs against whatever is in it, so an
  abandoned tree fails everyone's gate (stray `.nyc_output/` did exactly this). Either commit to
  your branch — a WIP commit with a clear message is fine — or
  `git stash push -u -m '<task>: <why>'`. Never leave a large unexplained dirty tree.

## Contended files

Nearly every task touches these, so they are where merges go wrong.

| File                                                                          | What to do                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/threat-model.md`, `docs/security/findings.md`                           | Prettier pads these tables. A row **wider than the current widest** re-pads every line and turns a one-line change into a 200-line diff that conflicts with everyone. Keep new rows inside the existing column widths (measure before you commit). Take the next threat number **above** any in-flight range: W11 used T108–T120, so W10b took T121. |
| `apps/server/src/app.ts`                                                      | Every feature registers here. Keep it to one import and one call, grouped with the others, so the hunk stays separable.                                                                                                                                                                                                                              |
| `apps/server/src/authz-matrix.test.ts`                                        | A new `/api` route must be added to `EXPECTED`, and to `TOKEN_SCOPES` if it accepts bearer tokens. CI fails otherwise.                                                                                                                                                                                                                               |
| `docs/PLAN.md`                                                                | In `.prettierignore`, and edits are whole-line: expect conflicts. Keep them small.                                                                                                                                                                                                                                                                   |
| `.gitignore`, `.prettierignore`, `pnpm-workspace.yaml`, `.github/workflows/*` | Repo-wide. Say so on the board before changing.                                                                                                                                                                                                                                                                                                      |

## Before you push

- `pnpm check` (needs `BOKYDO_TEST_DATABASE_URL` for the integration tests; they skip without it).
  Docker and web changes also want `docker/smoke-test.sh`.
- **The test database is shared and every test file drops the schema**, so two server test runs at
  once used to destroy each other (`42P01 relation "users" does not exist` — which looks exactly
  like a real failure). The server suite now takes a Postgres advisory lock for its whole run:
  if you see `Waiting for the shared test database (another test run is using it)…`, another agent
  is testing and yours is queued. Let it wait — it is released automatically if a run dies.
- Keep `main`'s history clean: one slice, one commit, no unrelated reformatting.
- A worktree outside the session workspace is not writable in this environment — branches in the
  shared checkout are how work is isolated here.

## Where to look

Deliberately no snapshot table here: the one this file started with was wrong within hours. The
live state lives in two commands, not a document.

- `git branch -vv` — what exists and what tracks what. Unpushed work is invisible to everyone else,
  so push early.
- `gh pr list` — what is waiting for review.

One branch nobody owns: `a1-android-wip` is a preservation copy of the pre-commit A1 tree, since
superseded by the real A1 work. Safe to delete whenever someone with the branch confirms it.
