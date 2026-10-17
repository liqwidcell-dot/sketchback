<img width="1321" height="679" alt="2026_10_16_02_09_29_screenshot" src="https://github.com/user-attachments/assets/87698797-f3cd-4e2a-bae0-33c1c5d79a7e" />
# Sketchback

An idea notebook. Obsidian-shaped, but the atom isn't a paragraph — it's a **block**,
and a block can be ink, a photo, a voice memo, or a file. Project boards are a view
over the link graph, not a separate thing.

Solo project. ~12 weeks, ~10h/week. Desktop app: Tauri v2 + React 19 + TypeScript,
local-first, single user, optional sync to a Terra box.

The full spec lives in [`plan-final.md`](./plan-final.md). It is the source of truth.

## Status

Week 2 of 12. Ideas are created, renamed, deleted and survive a restart. A text
block is a real TipTap editor per block, with markdown shortcuts going in and
markdown coming out. The command palette (`Ctrl+K`) carries every markdown
element, a slash menu inserts blocks, themes are day/night/system with an
optional custom accent, and an idea exports as a folder of linked `.md` files.

Sketches, photos, voice notes, files, boards, links and sync do not exist yet —
they are the rest of the plan.

There is a one-page demo at <https://liqwidcell-dot.github.io/sketchback/>
(source in [`docs/`](./docs) — that folder name is GitHub Pages' requirement for
serving a branch subfolder).

## Develop

```sh
npm install
npm run tauri dev      # launches the desktop app with HMR
```

Other scripts: `npm run build` (frontend bundle), `npm run typecheck`.

## Layout

```text
src/main.tsx          the whole frontend: Platform, store, views, palette, router
src/styles.css        Tailwind 4 entry + the design tokens from plan §27
src-tauri/src/main.rs the Rust shell: SQLite schema + migrations
docs/index.html       the demo page: one static file, no build step
```

Files are intentionally few. Same-type code is kept in one file (the plan's
`platform/`, `db/`, `views/`, `components/` split is collapsed until it earns its
keep — see the file-count rule).
<img width="1317" height="680" alt="2026_10_16_01_18_07_screenshot" src="https://github.com/user-attachments/assets/632fc9f9-47d9-4cee-b6f3-0b230ec4624f" />
<img width="1323" height="679" alt="2026_10_16_01_18_22_screenshot" src="https://github.com/user-attachments/assets/598645f2-3413-44cd-a17c-44db78bcee58" />

