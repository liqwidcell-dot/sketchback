# Sketchback

An idea notebook. Obsidian-shaped, but the atom isn't a paragraph — it's a **block**,
and a block can be ink, a photo, a voice memo, or a file. Project boards are a view
over the link graph, not a separate thing.

Solo project. ~12 weeks, ~20h/week. Desktop app: Tauri v2 + React 19 + TypeScript,
local-first, single user, optional sync to a Terra box.

The full spec lives in [`plan-final.md`](./plan-final.md). It is the source of truth.

## Status

Week 1 — Foundation. The skeleton runs: a vault opens, ideas are created, renamed,
deleted, and survive a restart. Blocks, sketches, and sync do not exist yet.

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
```

Files are intentionally few. Same-type code is kept in one file (the plan's
`platform/`, `db/`, `views/`, `components/` split is collapsed until it earns its
keep — see the file-count rule).
