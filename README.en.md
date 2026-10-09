# dsh-boot-video

**A full-screen video boot splash for DeepSeek Harness (DSH).**
Your clip plays once on every client boot, then fades into the app. Click anywhere or press `Esc` to skip.

[中文](README.md) | English

## Features

- 🎬 **One mp4 = one boot intro** — plays to its end, then fades into the real UI
- ⏭️ **Skippable** — click the picture or press `Esc`
- 🔊 **Plays with sound on the Desktop app** (Electron allows unmuted autoplay); a browser tab blocks it, so the clip falls back to muted and an "unmute" button appears next to it
- 🖥️ **Covers DSH's own boot card** — the first frame is injected by the host half while the document is still parsing, so `HARNESS / Loading plugins…` never shows
- 🔀 **Mutually exclusive with [550C boot](https://github.com/yannicksong0106/dsh-550c-boot)** — one three-way switch in Settings (my video / 550C / neither)
- 📦 **Zero runtime dependencies** — the host half uses `node:` builtins only; the browser half is one `<video>`

## Install

```sh
dsh plugin --profile web add dsh-boot-video
# or
dsh plugin --profile web add github:<owner>/dsh-boot-video
```

Then **restart DSH** and hard-refresh with **Ctrl+Shift+R**.

> **Desktop (Electron)**: `dsh plugin` refuses the `desktop` profile. Add the package to
> `profiles/desktop` manually (`pnpm add` + write the name into `dsh.profile.bundles`, **no BOM**),
> then **fully quit and relaunch** — that shell collects its index-injection table once at startup.

## Use

Settings → General → **开机动画 / Boot animation**:

| Option | Effect |
|---|---|
| **My video** (default) | plays this plugin's `assets/boot.mp4` and switches 550C off |
| **550C** | this plugin steps aside and releases 550C |
| **Neither** | both off, boot straight through |

There is a **Preview** button next to it. Playback is muted by default; the bottom-left button unmutes
without skipping. Every client load plays the clip (a page refresh counts).

## Bring your own clip

```sh
node scripts/make-asset.mjs <your-master.mp4> --height 1440 --crf 22
```

Uses the `@ffmpeg-installer/ffmpeg` devDependency (a plain npm package — no GitHub access needed) to
produce `assets/boot.mp4` as **H.264 + AAC + yuv420p + faststart**, typically 5–10 MB.

Requirements for a hand-made replacement: `.mp4`, H.264 video + AAC audio, ideally ≤ 15 MB and ≤ 20 s.
H.265/HEVC will not play in Chromium.

## How coexistence with 550C works

No code of theirs is touched: 550C's mode key is `localStorage['dsh-550c-boot:mode']`
(`off` / `simple` / `full`), and both its client half and its host first-frame script honour `off`.
This plugin writes that key. Our first frame sits at `z-index 2147482001` and our overlay at
`2147483100` — one notch above 550C's — so the two never fight even during the first load.

## Compatibility and limits

- Requires **DSH >= 0.2.0-rc.1**
- Cannot paint before Electron's first window frame (a brief blank window remains)
- The first frame is a **solid colour** (`#000000`), not the clip's first picture
- A browser tab cannot autoplay with sound — playback starts muted by policy
- The clip ships inside the package and is streamed by a host route with Range / 206 / 304 support

## Licence

MIT for the code. `assets/boot.mp4` is a distributed asset — make sure you have the right to
redistribute whatever clip you put there.

[MIT](LICENSE)
