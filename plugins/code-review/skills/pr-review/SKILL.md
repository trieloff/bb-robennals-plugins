---
name: pr-review
description: Use when asked to review a GitHub pull request and report findings to the BB Code Review panel — i.e. whenever a prompt names a review id like "owner/repo#123" or tells you to run `bb code-review submit`. Covers the findings JSON contract and the submit step.
---

# Reporting pull request review findings

The Code Review panel starts a review by spawning a thread with a review id
(`owner/repo#123`) and a findings path. Your job is to review the PR and hand
the findings back as structured JSON. The user then edits and posts each
comment themselves.

## The loop

1. **Read the change.** The plugin already fetched it — you do **not** need
   `gh`, and you do not need network access:

   ```sh
   bb code-review context --review <owner/repo#123>   # description, discussion, changed files
   bb code-review diff    --review <owner/repo#123>   # the diff
   ```

   The diff is a snapshot pinned to the head commit the review started from, so
   its line numbers are the ones your findings must use. If the diff is too
   large to print at once, `diff` says so and lists the files; read them one at
   a time with `--file <path>`. `bb code-review files --review <id>` lists them
   with their line counts.

   Read the surrounding code in the checkout too. A diff on its own rarely
   shows whether a change is correct.

2. **Review it** using whatever skills the prompt named. If it named none,
   review for correctness bugs, missing tests, security problems, and design
   issues.

3. **Write the findings file** to the path the prompt gave you. Print the exact
   schema any time with:

   ```sh
   bb code-review schema
   ```

4. **Submit it.**

   ```sh
   bb code-review submit --review <owner/repo#123> --file <path>
   ```

   `bb code-review context --review <owner/repo#123> --json` reprints the
   configured skills and the findings path if you lose them.

## Writing good findings

Each finding has five parts, and they are not interchangeable:

- **`background`** — what the code does, so a reader who has not been in this
  file can follow the rest. Not a restatement of the problem.
- **`problem`** — what is actually wrong and why it matters. Concrete: the
  input, the state, the wrong result.
- **`suggestedFix`** — how you would fix it.
- **`suggestedComment`** — posted to GitHub verbatim. Write it *to the PR
  author*, not as a note to yourself: no "the user should", no restating what
  you did. Short and specific beats thorough and vague.
- **`file` / `startLine` / `endLine`** — where the comment anchors. Use line
  numbers in the **new** file (`side: "RIGHT"`); use `"LEFT"` and old-file line
  numbers only when commenting on a deleted line. A finding with no line
  anchors still works — it posts as a general PR comment instead.

Report only what you verified against the code. A finding you cannot point at
a specific file and line for is not worth the user's time to triage. If you
find nothing, submit a file with an empty `findings` array — that is a
meaningful result, not a failure.

## Rules

- **Do not run `gh`.** Everything about the PR is available from
  `bb code-review`, fetched server-side where GitHub access is configured. The
  agent sandbox often cannot reach `gh` anyway.
- **Never post to GitHub yourself**, and never approve or request changes. Every
  comment is reviewed and posted by hand from the panel.
- **Never modify the PR**, push commits, or edit files in the checkout.
- A single malformed finding is dropped with a warning and the rest are
  imported, so a stray field will not lose the whole review — but check the
  submit output for warnings.
