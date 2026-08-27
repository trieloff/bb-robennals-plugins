# PR Manager

A GitHub CLI-backed BB plugin for keeping ongoing pull requests visible and actionable.

- Lists open PRs authored by the authenticated GitHub user and recently merged PRs.
- Classifies each as WAITING, FAILING, FEEDBACK, APPROVED, or MERGED.
- Loads the last saved result immediately and only contacts GitHub when Refresh is clicked.
- Filters the list and status counts by repository, with recently active repositories first.
- Finds existing BB threads by remembered PR links or matching project branches.
- Fetches a PR-specific Git ref and spawns a managed BB worktree/thread when requested.
- Provides cached and explicit-refresh commands through `bb pr-manager list [--json]` and `bb pr-manager refresh [--json]`.

The merged-PR window and list limit are configurable in BB’s plugin settings. A connected machine needs `gh` installed and authenticated.
