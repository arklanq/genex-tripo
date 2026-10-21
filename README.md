# Tripo for Genex

A [Genex](https://github.com/genex-games/genex-desktop) plugin that makes 3D models with your own Tripo API key, instead of Genex credits.

## Install

1. In Genex, open **Plugins → Add → Install from GitHub** and paste `https://github.com/arklanq/genex-tripo`.
2. Press **Connect** and paste your API key from platform.tripo3d.ai (**API Keys**; it starts with `tsk_`).

## Tools

| Tool | What it does |
| --- | --- |
| `arklanq-tripo__status` | Shows your account, wallet balance and recent tasks. Free. |
| `arklanq-tripo__generate` | Runs one Tripo task (text or image to model, texture, rig, animate, stylize or convert) and saves the result in `assets/arklanq-tripo/`. Paid, and asks for consent each time. |
| `arklanq-tripo__retrieve` | Waits for an existing task and downloads it. Free. |

## Notes

- A call waits up to 150 s. After that, a still-running task can be picked up with `arklanq-tripo__retrieve`.
- Downloads are limited to 100 MiB per file.

## Develop

```bash
npm test
```

To check the package, run this from a genex-desktop checkout:

```bash
npm run plugin:doctor -- /path/to/genex-tripo/plugin
```

## Release

Bump `version` in `plugin/plugin.json` and `package.json`, commit, then push a matching tag, such as `v0.2.0`. The workflow publishes a GitHub release with `arklanq-tripo-<version>.zip`.
