# bb-plugins

Personal plugins for the [BB](https://getbb.app) IDE. Each plugin lives under
`plugins/` and is indexed by `.bb/plugins.json`.

| Plugin | What it does |
| --- | --- |
| [code-review](plugins/code-review) | List the PRs awaiting your review, run your review skills on one, and post the findings to GitHub comment by comment. |
| [pr-manager](plugins/pr-manager) | Track your own open PRs and recent merges, summarised as WAITING / FAILING / FEEDBACK / APPROVED / MERGED, with links to matching BB threads. |

Both need a connected BB machine with the GitHub CLI installed and
authenticated (`gh auth login`).

## Installing

Each plugin installs on its own, by name:

```sh
bb plugin install git:https://github.com/robennals/bb-plugins.git@main --plugin code-review
bb plugin install git:https://github.com/robennals/bb-plugins.git@main --plugin pr-manager
```

`--plugin <name>` resolves against `.bb/plugins.json`; `--subdirectory
plugins/<name>` works too. A git install runs `npm install --omit=dev` and
builds the plugin for you, so there is nothing to run by hand. From a local
checkout, `bb plugin install path:. --plugin <name>`.

## Developing

```sh
cd plugins/<name>
npm install --include=dev
npm test
npm run typecheck
bb plugin install .   # install this working copy
bb plugin dev         # rebuild + reload on save
```

## Adding a plugin

Scaffold it, then index it so `--plugin <name>` can find it:

```sh
bb plugin new my-thing            # creates bb-plugin-my-thing/
mv bb-plugin-my-thing plugins/my-thing
```

```jsonc
// .bb/plugins.json
{ "name": "my-thing", "source": "./plugins/my-thing" }
```

The collection manifest is an index only — it never overrides a plugin's own
identity, entry points, or engine ranges, which stay in its `package.json`.
