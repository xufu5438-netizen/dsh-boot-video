# dsh-boot-video

**A full-screen video boot intro for DeepSeek Harness (DSH).**
It plays your mp4 at startup, fades into the real UI when the clip is done, and steps aside on a click
or `Esc`.

[![npm](https://img.shields.io/npm/v/dsh-boot-video?label=npm)](https://www.npmjs.com/package/dsh-boot-video)
[![GitHub](https://img.shields.io/github/stars/xufu5438-netizen/dsh-boot-video?label=GitHub)](https://github.com/xufu5438-netizen/dsh-boot-video)

## Features

- 🎬 **One mp4 = one boot intro** — plays to its end, then fades into the real UI
- ⏭️ **Skippable** — click the picture or press `Esc`
- 🔊 **Plays with sound on the Desktop app** (Electron allows unmuted autoplay); a browser tab blocks it, so the clip falls back to muted and an "unmute" button appears next to it
- 🖥️ **Covers DSH's own boot card** — the first frame is injected by the host half while the document is still parsing, so `HARNESS / Loading plugins…` never shows
- 🎞️ **Bring your own clip** — import an mp4 from the settings page; if Chromium cannot decode it (HEVC / H.265, common for 4K sources) the plugin offers to transcode it to H.264 for you
- 🔀 **No fighting with other splash plugins** — it only writes its own localStorage keys
- 📦 **Zero runtime dependencies** — the host half uses `node:` builtins only; the browser half is one `<video>`
- 🩺 **Self-check line** in the settings page: when the client half loaded, and whether the last boot actually played

## Install

```sh
# from npm (recommended)
dsh plugin --profile web add dsh-boot-video

# or straight from GitHub (build output is committed; there is no install-time script)
dsh plugin --profile web add github:xufu5438-netizen/dsh-boot-video
```

Then **restart DSH** and hard-refresh with **Ctrl+Shift+R**.

> **Desktop (Electron)**: `dsh plugin` refuses the `desktop` profile. Add the package from the app's
> own plugin manager (Settings → Plugins → Add plugin), or edit `profiles/desktop` by hand
> (`pnpm add` + the name in `dsh.profile.bundles`, **no BOM**), then **fully quit and relaunch** —
> that shell collects its index-injection table once at startup.

## Use

Settings → **开机动画 / Boot animation** (its own page in the settings sidebar):

| Option | Effect |
|---|---|
| **My video / 我的视频** | play the splash at startup |
| **Off / 不播放** | boot straight through |

Pick a clip from the strip (bundled ones plus anything you imported), hit **▶ Play once** to preview,
and **Import video** to add your own mp4 (512 MB max). After an import a small dialog asks for a name.
The footer shows the self-check line.

## Requirements for a hand-made replacement

`.mp4` container, H.264 video + AAC audio (H.265 / HEVC does not play in Chromium), ideally ≤ 15 MB
and ≤ 20 s.

## Compatibility and limits

- Requires **DSH >= 0.2.0-rc.1**
- Cannot paint before Electron's first window frame (a brief blank window remains)
- The first frame is a **solid colour** (`#000000`), not the clip's first picture
- A browser tab cannot autoplay with sound — playback starts muted by policy
- The clip ships inside the package and is streamed by a host route with Range / 206 / 304 support

## Licence

MIT for the code. The bundled `assets/hdd.mp4` — the *Hollow Deep Dive System* (HDD) boot animation —
is distributed **with the permission of its author,
[@露霁luki_yo on Bilibili](https://space.bilibili.com/3537104783018790)**.
The plugin never ships a clip it has no right to redistribute. Clips you import stay on your machine.

## Credits

- **HDD boot animation clip: provided with permission by
  [@露霁luki_yo](https://space.bilibili.com/3537104783018790) (Bilibili).**
- The "first frame wins over the boot card" approach was first proven and documented by
  [dsh-550c-boot](https://github.com/yannicksong0106/dsh-550c-boot) (Ziyang Song / Voidpoket);
  this plugin follows the same host contract.
