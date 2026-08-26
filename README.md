# bb-plugins

Plugins for the [BB](https://getbb.app) IDE.

| Plugin | What it does |
| --- | --- |
| [code-review](plugins/code-review) | List the PRs awaiting your review, run your review skills on one, and post the findings to GitHub comment by comment. |

## Installing

Each plugin installs on its own, by name:

```sh
bb plugin install git:https://github.com/robennals/bb-plugins.git@main --plugin code-review
```

`--plugin <name>` resolves against `.bb/plugins.json`; `--subdirectory
plugins/<name>` works too. A git install runs `npm install --omit=dev` and
builds the plugin for you, so there is nothing to run by hand.

## Developing

```sh
cd plugins/code-review
npm install
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
