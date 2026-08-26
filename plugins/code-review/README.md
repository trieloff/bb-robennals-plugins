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
3. **Skim the issues.** The review screen is a plain list: severity, title, and
   a three-line gist. Nothing else, plus one button through to the PR on GitHub.
4. **Open an issue** for the detail — background, problem, suggested fix — and
   below it, every file the issue points at, stacked, each showing just the
   cited lines with their real line numbers. That includes files the finding
   only mentioned in passing: `src/thing.ts:42` in its prose becomes a snippet.
   Any file header links to that file's place in the PR diff on GitHub.
5. **Act on it**: **post the comment verbatim**, **edit it first**, **discuss it
   with an agent** in a side tab, or **dismiss it**.

The panel remembers the repo and filter you were on, so re-opening the tab
resumes where you left off. Nothing reaches GitHub until you press
*Post comment*. The review agent is told
in as many words not to post, approve, request changes, or touch the PR.

## Setup

The GitHub CLI is the only transport, and it runs server-side, so whatever
`gh auth` can see on this machine, the plugin can:

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

## The review agent never touches GitHub

When a review starts, the plugin fetches the PR — description, discussion,
inline review comments, changed files, and the full diff — and stores it. The
review agent reads that snapshot over the `bb code-review` CLI instead of
running `gh` itself. Three reasons:

- **The agent sandbox usually cannot reach `gh`.** Its filtering proxy
  terminates TLS, and `gh` (a Go binary) rejects the interception with
  `x509: OSStatus -26276`. `curl` and `git` trust it; `gh` does not. The plugin
  runs in the BB server, which is not sandboxed, so its `gh` always works — and
  the CLI reaches it over loopback, which the sandbox permits.
- **The agent's environment may have no `gh` auth at all**, even where the
  server does.
- **The snapshot is pinned** to the head commit the review started from, so the
  line numbers in the findings match the diff the agent actually read, even if
  the PR moves underneath it.

```sh
bb code-review context --review owner/repo#123 [--json]  # description, discussion, files
bb code-review diff    --review owner/repo#123 [--file <path>]
bb code-review files   --review owner/repo#123
bb code-review schema                                    # the findings schema
bb code-review submit  --review owner/repo#123 --file <path>
```

A diff too large for one CLI response (the host caps a result at 1 MiB and
rejects an over-large one outright) makes `diff` list the files instead, to be
read one at a time with `--file`.

## How findings get in

The review agent writes a JSON file and submits it. That contract is
documented for agents in `skills/pr-review/SKILL.md`.

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
