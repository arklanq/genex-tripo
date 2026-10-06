# Tripo plugin for Genex

A [Genex](https://github.com/genex-games/genex-desktop) plugin that makes 3D models with **your own Tripo API key**, so tasks are paid from your Tripo wallet instead of Genex credits.

The package lives in [`plugin/`](plugin). Tests live outside it, so they are not installed.

## What it adds

- `tripo__status`: the account state, the wallet balance and the recent tasks. Free.
- `tripo__generate`: one paid Tripo task, with the user's consent each time. Operations: `text_to_model`, `image_to_model`, and, on an earlier task's model, `texture_model`, `animate_prerigcheck`, `animate_rig`, `animate_retarget`, `stylize_model` and `convert_model`.
- `tripo__retrieve`: waits for an existing task and downloads it. Free; never starts a new task.

Results are copied into the game under `assets/tripo/<task id>/` (`public/assets/…` for games with a build step): `model.<ext>` and `preview.<ext>`.

## Install

1. In Genex: **Plugins → Add → Install from GitHub** and paste `https://github.com/arklanq/genex-tripo`. Studio installs the latest release. To install by hand instead, download `tripo-<version>.zip` from [Releases](https://github.com/arklanq/genex-tripo/releases), unpack it and choose its folder with **Plugins → Add → Load local plugin…**.
2. Press **Connect** on the Tripo row, paste your key from platform.tripo3d.ai (API Keys, starts with `tsk_`) and press **Connect**. The plugin checks the key with Tripo before Studio saves it.
3. Studio unlocks the saved key again after a restart. If the panel asks for a key anyway, paste it again.

## Limits

- One call waits up to 150 s for a task and ends by 180 s, downloads included (Studio ends plugin calls after 190 s). Each Tripo request has 30 s. A longer task answers `running`, and a call that fails after Tripo accepted the task names it; either way the agent continues with `tripo__retrieve`.
- Downloads are accepted only from `*.tripo3d.ai` and `*.tripo3d.com`, without redirects, up to 100 MiB per file. They are removed from the plugin's storage once delivered into the game.
- Studio's `project.read` service reads text only, so `image_to_model` reads the image from the game folder itself. It refuses absolute paths, `..`, dot folders and `node_modules`.

## Develop

```bash
npm test
```

Check the package with Genex's doctor from a genex-desktop checkout:

```bash
npm run plugin:doctor -- /path/to/genex-tripo/plugin
```

## Release

Bump `version` in `plugin/plugin.json` and `package.json`, commit, then push a matching tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The Release workflow runs the tests and publishes a GitHub release with `tripo-<version>.zip` attached.
