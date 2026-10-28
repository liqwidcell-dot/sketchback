# Sketchback

An idea notebook for one person. Obsidian-shaped — markdown in, markdown out —
with one difference: the atom isn't a paragraph, it's a **block**. A block can
be text, ink, a photo, a voice memo, or a file.

It's a desktop app — Tauri v2, React 19, TypeScript, local-first, single user.

## Download

Two single files, both built by CI:

| Platform | File | Needs |
| --- | --- | --- |
| Windows 10/11 | `Sketchback-0.1.0-portable-x64.exe` | WebView2 (on Windows 11, and effectively all of Windows 10) |
| Linux x86_64 | `Sketchback_0.1.0_amd64.AppImage` | glibc 2.34+, FUSE2 (or `--appimage-extract-and-run`) |

Grab the one for your machine from [GitHub Releases](https://github.com/liqwidcell-dot/sketchback/releases).

**Windows:** there's no installer — just run the `.exe`. Your notes live in
`%APPDATA%\com.sketchback.app\`. It's unsigned, so Windows will show a
SmartScreen warning; pick "More info" → "Run anyway".

**Linux:** `chmod +x` the AppImage and run it. If FUSE2 isn't available, use
`--appimage-extract-and-run`. Your notes live in
`~/.config/com.sketchback.app/`.

## Getting started

When you open the app you'll see an empty vault. Click the `+` in the sidebar
to make your first idea — it opens with somewhere to type right away.

## What works today

- Create, rename, delete and reopen ideas — they survive a restart
- One editor per block, with markdown going in and coming out
- Every markdown element is a command in the palette on `Ctrl+K`
- Day / night / system themes, plus your own accent colour
- Export an idea as a folder of linked `.md` files, ready for Obsidian

Sketches, photos, voice notes, boards, links, tags, search and sync aren't
there yet.

## One-page demo

There's a demo page at <https://liqwidcell-dot.github.io/sketchback/>.
