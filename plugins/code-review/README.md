# Code Review

Review GitHub pull requests with agents, then post each finding to GitHub
yourself — one comment at a time, edited how you want it.

## The loop

1. **Pick a PR.** The panel lists a repo's open pull requests, filtered by who
   was asked to review: **Asked me**, **Asked my team** (any of them, or one you
   pick), or **All open**.
2. **Review it.** Press *Review this PR*. A BB thread runs the review skills you
   configured against the change and writes structured findings to a JSON file,
   then submits them with `bb code-review submit`.
3. **Act on each finding.** Every finding arrives with the background, the
   problem, a suggested fix, and a ready-to-post comment. For each one you can
   **post it to GitHub verbatim**, **edit the comment first**, **discuss it with
   an agent** in a side tab, or **dismiss it**.

Nothing reaches GitHub until you press *Post comment*. The review agent is told
in as many words not to post, approve, request changes, or touch the PR.

## Setup

The GitHub CLI is the only transport, so whatever `gh auth` can see, this can:

```sh
gh auth login
gh auth refresh -s read:org   # so `Asked my team` can list your teams
```

Then, in **Settings → Plugins → Code Review**:

| Setting | What it does |
| --- | --- |
| **Repositories** | Extra `owner/repo` lines to track. Repos whose checkouts are BB project sources are discovered automatically from their `origin` remote. |
| **Review skills** | Skill names the review agent runs, one per line. Defaults to `code-review`. Empty means a generic review. |
| **Extra review instructions** | Appended to every review prompt — house rules, things to always check, things to never comment on. |
| **Findings directory** | Where the agent writes its findings JSON, relative to the checkout. Defaults to `.bb/code-review`. |
| **Default BB project** | Where review threads spawn for repos not attached to a BB project. |
| **Teams** | `org/team` lines, if you would rather not grant `read:org`. |

Settings do not auto-reload: run `bb plugin reload code-review` after changing
one.

## Filters

GitHub's own `review-requested:@me` quietly folds in requests made to teams you
belong to, so it cannot tell "someone asked *me*" apart from "someone asked a
team I'm in". This plugin reads each PR's actual review requests and filters
them itself, so the two are separate:

- **Asked me** — a review request naming you.
- **Asked my team** — a request naming one of your teams, with a picker to
  narrow to a specific one.
- **All open** — every open PR in the repo.

## How findings get in

The review agent writes a JSON file and submits it. That contract is
documented for agents in `skills/pr-review/SKILL.md`, and the CLI is:

```sh
bb code-review schema                                    # print the findings schema
bb code-review context --review owner/repo#123           # the PR, skills, and findings path
bb code-review submit  --review owner/repo#123 --file <path>
```

Each finding carries five things, deliberately kept apart:

| Field | Purpose |
| --- | --- |
| `file`, `startLine`, `endLine`, `side` | Where the comment anchors. No line anchor still works — it posts as a general PR comment. |
| `background` | What the code does, for a reader who has not been in this file. |
| `problem` | What is actually wrong and why it matters. |
| `suggestedFix` | How the agent would fix it. |
| `suggestedComment` | Posted to GitHub verbatim, unless you edit it first. |

A single malformed finding is dropped with a warning and the rest are imported;
`submit` reports the warnings but still succeeds.

Re-running a review replaces the findings you have not acted on and keeps the
ones you have — posted comments are history, and a dismissal is a decision you
should not have to make twice.

## Development

```sh
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
bb plugin dev     # rebuild + reload on save
```

The pure logic — the findings contract, the prompt, PR filtering, patch
splitting, and the `gh api` argv for posting a comment — lives in
`review-core.ts` and is unit-tested without a server. `server.ts` is the
registrations and the gh plumbing; `app.tsx` is the panel.
