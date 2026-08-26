# bb-plugins

Personal plugins for the BB IDE. Each plugin lives under `plugins/` and is indexed by `.bb/plugins.json`.

## PR Manager

PR Manager shows open PRs authored by the current GitHub CLI user, plus PRs merged in the last 14 days. It remembers the last successful result and only contacts GitHub when Refresh is clicked. It summarizes CI and review state as WAITING, FAILING, FEEDBACK, APPROVED, or MERGED, filters by repository with recently active repositories first, links matching BB threads, and creates a managed worktree/thread from the PR head when needed.

Requirements: a connected BB machine with the GitHub CLI installed and authenticated (`gh auth login`). Repositories must be registered as BB projects before PR Manager can create threads for them.

```sh
bb plugin install path:. --plugin pr-manager
bb plugin reload pr-manager
```

For development:

```sh
cd plugins/pr-manager
npm install --include=dev
npm test
bb plugin build
```
