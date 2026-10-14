# Sketchback

**An idea notebook.** An Obsidian-shaped app where the atom isn't a paragraph, it's a _block_ — and a block can be ink, a photo, a voice memo, or a file. Project boards are a view over the link graph, not a separate thing.

Solo project. ~12 weeks, ~20h/week, ~240h total.
Target: desktop app (Tauri v2), local-first, single user, optional sync to a Hack Club Terra box.

---

## Table of contents

1. [Product definition](#1-product-definition)
2. [Non-goals](#2-non-goals)
3. [Stack and rationale](#3-stack-and-rationale)
4. [Architecture](#4-architecture)
5. [Prerequisites and accounts](#5-prerequisites-and-accounts)
6. [Repository layout](#6-repository-layout)
7. [Data model](#7-data-model)
8. [The op log](#8-the-op-log)
9. [Block system](#9-block-system)
10. [Sketch engine](#10-sketch-engine)
11. [Media pipeline](#11-media-pipeline)
12. [Blob store](#12-blob-store)
13. [Links, backlinks and search](#13-links-backlinks-and-search)
14. [Boards](#14-boards)
15. [Sync protocol](#15-sync-protocol)
16. [Server](#16-server)
17. [Import and export](#17-import-and-export)
18. [Security and privacy](#18-security-and-privacy)
19. [Performance budget](#19-performance-budget)
20. [Testing strategy](#20-testing-strategy)
21. [Week-by-week plan](#21-week-by-week-plan)
22. [Risk register](#22-risk-register)
23. [Cut ladder](#23-cut-ladder)
24. [Stretch list](#24-stretch-list)
25. [Pixl compliance](#25-pixl-compliance)
26. [Open questions](#26-open-questions)

---

## 1. Product definition

### The one-line pitch

Obsidian, but every idea is a stack of blocks, and blocks can be ink, photos, voice memos, or files. Boards are just a view over the link graph.

### The three wedges

| Wedge                      | Why it wins                                                                                 | What makes it hard                                     |
| -------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Sketch layer**           | Infinite-canvas vector ink inside a note. Zoom forever, tiny files, feels great with a pen. | Stroke storage model, canvas performance               |
| **Photo / media**          | Drop 400 phone photos into an idea and the app doesn't die.                                 | Content-addressed blobs, thumbnailing, memory pressure |
| **Boards as linked views** | A kanban whose cards _are_ your ideas. Drag a card and the idea moves.                      | Keeping the graph consistent across three surfaces     |

### The unification trick

All three stay cheap because of one rule: **everything is a blob or a block, blocks are addressable, links are rows.** A sketch is a block. A photo is a block plus one or more blobs. A voice note is a block plus one blob plus a peaks array. A board is a container of links to ideas. Nothing gets a bespoke persistence path.

### Core objects

```
Vault
 └── Idea            (what Obsidian calls a note; "idea" is the product word)
      └── Block      (text | sketch | image | audio | file | callout | embed)
           └── Blob  (bytes, content-addressed, on disk)
 └── Board
      └── Column
           └── Card  (a reference to an Idea)
 └── Link            (directed edge: idea → idea)
 └── Tag
 └── Op              (append-only mutation log; drives undo + sync)
```

### Definition of done (week 12)

Someone who has never seen the app can: open it, create an idea, type in it, sketch on it with a stylus, drop 50 photos in, record a voice memo, link three other ideas with `[[wikilinks]]`, see the backlinks show up on those ideas, drop the idea onto a kanban board, drag the card between columns, have all of it sync to a second machine, and open a read-only share link from a phone browser.

---

## 2. Non-goals

Written down so they don't creep back in.

| Not doing | Why |
|---|---|
| Real-time multi-user collaboration | Weeks 10–12 are better spent on polish. Single user means LWW conflict resolution, which is a weekend. |
| Mobile app | Tauri mobile shares ~70% of the UI but canvas + audio on a phone is a different product. Revisit after ship. |
| A plugin API | Enormous surface. Sketchback's own block registry is the first version of it; expose it when a second consumer exists. |
| Markdown as the storage format | The whole point is that a paragraph is one of several block types. Markdown cannot round-trip ink. Import *from* Markdown yes; store *as* Markdown no. |
| AI features / autocomplete | Tempting, distracting, and it changes the character of the app. |
| Backwards compatibility guarantees before week 11 | Schema churn is cheap early. Freeze at week 11. |
| Any form of cloud account beyond the sync server | |

---

## 3. Stack and rationale

### Chosen

| Layer | Choice | Notes |
|---|---|---|
| Shell | **Tauri v2** | Rust binary, OS webview. App bundle ~10–40MB vs ~250MB for Electron. |
| Frontend | **React 19 + TypeScript** | |
| Build | **Vite 6** | |
| Styling | **Tailwind CSS 4** | CSS-first config, no PostCSS config file needed. |
| State | **Zustand** | One normalized store keyed by `block_id`. No Redux ceremony. |
| Text editing | **TipTap v2** (ProseMirror) | One instance *per text block*, not one per document. |
| Sketch | **perfect-freehand** + Canvas2D | Vector strokes, pressure/tilt aware. No PixiJS. |
| Database | **SQLite** via `tauri-plugin-sql` | Local-first, single file, no server needed. |
| ORM / migrations | **Drizzle** | Drizzle targets SQLite cleanly and emits plain SQL migrations. |
| Server | **Node 22+ + Fastify + better-sqlite3** | On the Terra box. |
| Tests | **Vitest** (logic), **Playwright** (E2E) | |

### Rejected, with reasons

**Electron instead of Tauri.** Electron would be ~2 weeks faster — no Rust, everything in TypeScript, `better-sqlite3` works, file APIs are trivial. Rejected because: (a) a 250MB app for a note-taking tool is a real quality signal against this project's premise, (b) the Rust surface here is genuinely small (~400 lines: blob paths, fs watch, share sheet, mic fallback), and (c) memory ceiling is much lower, which matters for a photo-heavy app. **If week 3 arrives and Rust is the blocker, switching to Electron costs about a week. That is an acceptable failure, and it is a deliberate one.**

**Yjs / CRDTs.** The right tool if two humans type in the same block. Wrong tool for one human with a laptop and a desktop. CRDT merge bugs are the kind you find in week 11. Replaced by an op log + LWW. Revisit only if Pixl rewards real collab (it doesn't).

**PixiJS / Fabric.js / Konva for the canvas.** perfect-freehand emits already-outlined geometry. Fabric adds a retained scene graph, serialization format, and hit-testing model I'd spend weeks fighting. Raw Canvas2D with a dirty-rect redraw loop is ~300 lines and I control every pixel. Revisit if a sketch ever needs >2,000 strokes on screen at once.

**Markdown-first storage.** Covered in non-goals.

**Ratatui / a TUI.** This is an app with a canvas. No.

### Platform targets

**Primary: macOS + Windows.** Primary because pen input and `getUserMedia` are most reliable there.
**Secondary: Linux.** Best-effort. WebKitGTK's `getUserMedia` is unreliable; the app should degrade to "no voice notes" rather than fail to launch. Linux/GTK gets a plain-canvas fallback path for the mic in week 6 if needed.

---

## 4. Architecture

### Process model

```
┌─────────────────────────────────────────┐
│ System webview (WKWebView / WebView2)   │
│   React app, Canvas2D, TipTap, Zustand  │
│   All UI, all rendering, all crypto     │
└──────────────┬──────────────────────────┘
               │ Tauri IPC (invoke / events)
┌──────────────▼──────────────────────────┐
│ Rust core                               │
│   SQLite handle  (rusqlite / plugin-sql)│
│   Blob read/write on disk               │
│   sha256 hashing                        │
│   fs watch                              │
│   mic fallback (cpal)                   │
│   share sheet                           │
└──────────────┬──────────────────────────┘
               │ file IO
       <vault>/.sketchback/
       ├── sketchback.db        SQLite
       └── blobs/<aa>/<hash>.<ext>
```

### The Platform interface

Every host capability goes through one TypeScript interface, defined **week 1**, before any of them is implemented for real:

```ts
interface Platform {
  db: {
    all<T>(sql: string, params?: unknown[]): Promise<T[]>
    run(sql: string, params?: unknown[]): Promise<void>
  }
  fs: {
    readBlob(hash: string): Promise<Uint8Array>
    writeBlob(data: Uint8Array, mime: string): Promise<string>  // returns hash
    blobPath(hash: string): Promise<string>
    statBlob(hash: string): Promise<{ size: number } | null>
    deleteBlob(hash: string): Promise<void>
  }
  hash: { sha256(data: Uint8Array): Promise<string> }
  dialog: { pickFiles(): Promise<PickedFile[]>; saveFile(name: string, data: Uint8Array): Promise<string | null> }
  mic: { isAvailable(): Promise<boolean>; start(): Promise<MicSession>; stop(): Promise<Blob> }
  app: { vaultRoot(): Promise<string>; version(): Promise<string> }
}
```

Two implementations:

- `TauriPlatform` — the real one.
- `MemoryPlatform` — in-memory Maps + fake timers, used by Vitest.

**Why this exists:** it makes every non-UI module (op fold, sync merge, wikilink parser, peaks computation, thumbnail pipeline) testable in a plain Node process with no webview, no Rust, no Tauri build. That is worth a full week of avoided friction. **Do not** build a browser/PWA implementation of this interface — it's a test seam, not a product.

### Data flow on a mutation

```
User keystroke
  → Zustand action
  → op created { id, device_id, seq, ts, idea_id, type: "block.update", payload }
  → optimistic local apply (UI already updated)
  → op appended to `ops` + SQL `UPDATE block SET ...`
  → debounced 400ms → POST to sync (if online)
  → failure → stays in `pending_ops`, retried on next flush / reconnect
```

Optimistic local apply is mandatory. There is no "await the database" in a keystroke path.

---

## 5. Prerequisites and accounts

Set these up in week 1, before any feature work. Each one is a day lost if discovered in week 9.

| # | Thing | Why | Action |
|---|---|---|---|
| 1 | **Rust toolchain** + Tauri v2 prerequisites | Blocks the shell | `rustup`, then platform deps (Linux: `libwebkit2gtk-4.1-dev`, `build-essential`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`) |
| 2 | **Hackatime API key** | Hours → pixels. Fix the name now: `sketchback`. | VSCodium: `Ctrl+Shift+P` → "Hackatime: Setup Wizard". **Note: as of this writing the extension is installed but has no API key set — no heartbeat has ever been sent.** Do this first. |
| 3 | **GitHub account + repo** | Pixl requires a public repo with real history | Create `github.com/<you>/sketchback`, push from week 1 |
| 4 | **Terra server access** | Sync target in weeks 10–11 | Request access; confirm you can run a long-lived Docker container and that you know the hostname |
| 5 | **A domain** (optional) | For share links in week 11 | Hack Club grants these via stardust |
| 6 | **Pen input hardware** (optional but recommended) | You cannot evaluate a sketch feature with a mouse | Wacom / XP-Pen / iPad. If none, use a trackpad and be honest in your quality bar |
| 7 | **Upgrade signing key** (week 12 only) | Auto-updater needs minisign | Generate at week 12, not earlier |
| 8 | **Obsidian vault** | Week 12 importer needs a real corpus to test against | You already have one |

### Pixl project creation timing

Pixl cannot be created on day 1: ship requirements are a public repo with meaningful commit history, a working demo link, a thumbnail, journal entries, and AI disclosure. **Create the Pixl project at the end of week 2**, once there is a demoable shell. Until then, hours still accumulate on Hackatime under `sketchback` — that's what matters, and that's what the Pixl project will later point at.

---

## 6. Repository layout

```
~/projects/sketchback/
├── PLAN.md                        ← this file
├── JOURNAL.md                     ← per-session entries (Pixl requires these)
├── README.md
├── .wakatime-project              ← "sketchback"
├── .gitignore
├── docs/
│   ├── schema.md                  ← generated DDL reference
│   └── adr/                       ← architecture decision records, one per major choice
├── src/                           ← TypeScript frontend
│   ├── main.tsx
│   ├── app/
│   │   ├── routes.tsx
│   │   ├── commands.ts            ← command palette registry (one source of truth)
│   │   └── keymap.ts
│   ├── platform/
│   │   ├── Platform.ts            ← the interface
│   │   ├── tauri.ts               ← real impl
│   │   └── memory.ts              ← test impl
│   ├── db/
│   │   ├── schema.sql
│   │   ├── migrate.ts
│   │   └── queries.ts             ← all SQL in one file, typed
│   ├── core/                      ← pure logic, zero DOM, fully unit-testable
│   │   ├── op.ts                  ← op creation, application, fold
│   │   ├── sync.ts                ← merge, LWW, version vectors
│   │   ├── links.ts               ← wikilink parse/resolve/rename cascade
│   │   ├── orderKey.ts            ← fractional indexing
│   │   ├── sketch/
│   │   │   ├── stroke.ts          ← stroke types + quantization
│   │   │   ├── geometry.ts        ← bbox, hit-test, simplify
│   │   │   └── export.ts          ← SVG / PNG rasterization
│   │   └── audio/
│   │       ├── peaks.ts           ← waveform computation
│   │       └── codecs.ts          ← format detection + fallback
│   ├── blocks/
│   │   ├── registry.ts            ← block type registration
│   │   ├── TextBlock.tsx
│   │   ├── SketchBlock.tsx
│   │   ├── ImageBlock.tsx
│   │   ├── AudioBlock.tsx
│   │   ├── FileBlock.tsx
│   │   └── CalloutBlock.tsx
│   ├── views/
│   │   ├── IdeaView.tsx
│   │   ├── Sidebar.tsx
│   │   ├── BacklinksPanel.tsx
│   │   ├── SearchPalette.tsx
│   │   ├── GraphView.tsx          ← stretch
│   │   └── BoardView.tsx
│   ├── components/                ← shared UI
│   ├── workers/
│   │   ├── thumbnail.worker.ts
│   │   └── peaks.worker.ts
│   └── styles/
├── src-tauri/                     ← Rust
│   ├── src/main.rs
│   ├── src/commands.rs
│   ├── capabilities/default.json  ← Tauri v2 permissions (easy to forget, silent failures)
│   ├── tauri.conf.json
│   └── icons/
├── server/                        ← sync server (weeks 10–11)
│   ├── src/index.ts
│   ├── src/routes/
│   ├── drizzle/
│   └── Dockerfile
└── e2e/
```

### Why `core/` is DOM-free

`op.ts`, `sync.ts`, `links.ts`, `orderKey.ts`, `sketch/*`, `audio/peaks.ts` contain the entire algorithmic risk of the project and none of it needs a browser. Keeping them pure means they're testable in milliseconds, which is the difference between a 2-minute and a 2-hour feedback loop while debugging the merge logic.

---

## 7. Data model

SQLite. Timestamps are integer Unix **milliseconds** (`INTEGER`), never seconds — mixed units are a classic sync bug. Booleans are `INTEGER 0|1`.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ─── Vault ────────────────────────────────────────────────────────────────
CREATE TABLE vault (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
-- One row. Present so a future multi-vault mode is a migration, not a rewrite.

-- ─── Devices ──────────────────────────────────────────────────────────────
CREATE TABLE device (
  id          TEXT PRIMARY KEY,          -- uuid v4, generated per install
  name        TEXT NOT NULL,             -- "Bird's MacBook"
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER
);

-- ─── Ideas ────────────────────────────────────────────────────────────────
CREATE TABLE idea (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT 'Untitled',
  icon        TEXT,                      -- emoji
  color       TEXT,                      -- hex or token name
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER,                   -- soft delete; tombstone propagates via sync
  archived_at INTEGER
);
CREATE INDEX idx_idea_updated ON idea(updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_idea_title   ON idea(title COLLATE NOCASE);

-- ─── Blocks ───────────────────────────────────────────────────────────────
CREATE TABLE block (
  id          TEXT PRIMARY KEY,
  idea_id     TEXT NOT NULL REFERENCES idea(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,             -- text|sketch|image|audio|file|callout|embed
  order_key   TEXT NOT NULL,             -- fractional index (see §9)
  data_json   TEXT NOT NULL DEFAULT '{}',-- type-specific payload, no blobs inlined
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX idx_block_idea ON block(idea_id, order_key) WHERE deleted_at IS NULL;

-- ─── Links ────────────────────────────────────────────────────────────────
CREATE TABLE link (
  id           TEXT PRIMARY KEY,
  from_idea_id TEXT NOT NULL REFERENCES idea(id) ON DELETE CASCADE,
  to_idea_id   TEXT REFERENCES idea(id) ON DELETE SET NULL,  -- NULL = unresolved
  to_title     TEXT NOT NULL,            -- denormalised; survives rename cascade
  block_id     TEXT REFERENCES block(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,            -- wiki|mention|board|embed
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_link_from ON link(from_idea_id);
CREATE INDEX idx_link_to   ON link(to_idea_id) WHERE to_idea_id IS NOT NULL;
CREATE INDEX idx_link_title ON link(vault_unscoped_title)  -- replaced below

-- ─── Blobs ────────────────────────────────────────────────────────────────
CREATE TABLE blob (
  hash        TEXT PRIMARY KEY,          -- sha256 hex
  size        INTEGER NOT NULL,
  mime        TEXT NOT NULL,
  ext         TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL           -- LRU / GC bookkeeping
);

CREATE TABLE block_blob (
  block_id  TEXT NOT NULL REFERENCES block(id) ON DELETE CASCADE,
  blob_hash TEXT NOT NULL REFERENCES blob(hash) ON DELETE RESTRICT,
  role      TEXT NOT NULL,               -- original|thumb|render|peaks
  PRIMARY KEY (block_id, blob_hash, role)
);
CREATE INDEX idx_block_blob_hash ON block_blob(blob_hash);

-- ─── Boards ───────────────────────────────────────────────────────────────
CREATE TABLE board (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  icon       TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE board_column (
  id        TEXT PRIMARY KEY,
  board_id  TEXT NOT NULL REFERENCES board(id) ON DELETE CASCADE,
  title     TEXT NOT NULL,
  order_key TEXT NOT NULL,
  wip_limit INTEGER                      -- NULL = unlimited; optional soft warning
);
CREATE INDEX idx_column_board ON board_column(board_id, order_key);

CREATE TABLE board_card (
  id         TEXT PRIMARY KEY,
  column_id  TEXT NOT NULL REFERENCES board_column(id) ON DELETE CASCADE,
  idea_id    TEXT NOT NULL REFERENCES idea(id) ON DELETE CASCADE,
  order_key  TEXT NOT NULL,
  note       TEXT,                       -- per-card note, not on the idea
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_card_column ON board_card(column_id, order_key);
CREATE INDEX idx_card_idea   ON board_card(idea_id);
-- An idea may appear on a board at most once:
CREATE UNIQUE INDEX uq_card_board_idea ON board_card(idea_id)
  WHERE idea_id IS NOT NULL;  -- (enforced per-board via join at app layer; see §14)

-- ─── Tags ─────────────────────────────────────────────────────────────────
CREATE TABLE tag (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE idea_tag (
  idea_id TEXT NOT NULL REFERENCES idea(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (idea_id, tag_id)
);

-- ─── Ops (the log) ────────────────────────────────────────────────────────
CREATE TABLE op (
  id           TEXT PRIMARY KEY,          -- uuid; the idempotency key
  device_id    TEXT NOT NULL REFERENCES device(id),
  seq          INTEGER NOT NULL,         -- per-device, gapless, starts at 1
  ts           INTEGER NOT NULL,
  idea_id      TEXT,                     -- NULL for vault-level ops
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  server_seq   INTEGER                   -- NULL until accepted by the server
);
CREATE UNIQUE INDEX uq_op_device_seq ON op(device_id, seq);
CREATE INDEX idx_op_idea   ON op(idea_id, seq);
CREATE INDEX idx_op_unsent ON op(server_seq) WHERE server_seq IS NULL;

-- ─── Version vectors ──────────────────────────────────────────────────────
CREATE TABLE version (
  idea_id   TEXT NOT NULL,
  device_id TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  PRIMARY KEY (idea_id, device_id)
);
CREATE INDEX idx_version_device ON version(device_id, seq);

-- ─── Search ───────────────────────────────────────────────────────────────
CREATE VIRTUAL TABLE search USING fts5(
  idea_id UNINDEXED,
  title,
  body,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- ─── Unlinked mentions ────────────────────────────────────────────────────
CREATE TABLE mention (
  idea_id      TEXT NOT NULL,
  block_id     TEXT NOT NULL,
  title_lower  TEXT NOT NULL,
  PRIMARY KEY (idea_id, block_id, title_lower)
);
CREATE INDEX idx_mention_title ON mention(title_lower);

-- ─── Settings (key/value) ─────────────────────────────────────────────────
CREATE TABLE setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**Remove this line — it was a drafting artifact:**

```sql
CREATE INDEX idx_link_title ON link(vault_unscoped_title);  -- ❌ no such column
```

The correct index, needed for the unresolved-link and rename-cascade paths:

```sql
CREATE INDEX idx_link_title ON link(to_title COLLATE NOCASE);
```

### Data model notes

**Why soft-delete everywhere.** A hard `DELETE` can't be propagated through an op log — the other device never learns the thing existed, and a blob it holds becomes orphaned. Soft delete (`deleted_at`) is a normal op that folds like any other.

**Why `link` denormalises `to_title`.** Obsidian links by title, not ID. Storing only `to_idea_id` means renaming an idea requires rewriting every inbound link. Storing the title alongside means the rename cascade is a single indexed `UPDATE`, and links to ideas that don't exist yet still resolve later.

**Why `board_card` has a `note`.** Board cards are projections of ideas, but boards want ephemeral annotation ("ask Bird about this"). Putting it on the idea would pollute the idea with board context.

**Why `search` is maintained by the app, not by triggers.** Triggers on `block` fire on every keystroke. The app updates `search` on a 500ms debounce after block commit, which is ~1/1000th the write amplification.

---

## 8. The op log

### The bet

Every mutation is an op appended to `ops`. Idea and block state is *derived* by folding ops.

**One primitive buys five features:**

| Feature | How it falls out |
|---|---|
| Undo / redo | Fold ops backwards; undo = inverse op |
| Persistent history | `SELECT * FROM op WHERE idea_id=? ORDER BY seq` |
| Sync | Ops are the wire format |
| Conflict resolution | Ops carry `(device_id, seq, ts)` — enough for LWW |
| Audit / debugging | Every state change is inspectable |

### The cost, stated honestly

Folding ops is slower than reading rows, debugging is harder ("why is this block's text wrong?" requires replaying), and you can build a corrupted log that only manifests after 3 weeks. There is no `UPDATE idea SET title=?` escape hatch, so every bug is an op-application bug.

### Decision gate: **end of week 4**

At the end of week 4, the block editor and op fold will be ~2 weeks along. Evaluate:

- If fold is fast and bugs are localised → keep it.
- If you are fighting it → **switch to plain row updates**, keep a separate `change_log` table purely for sync, and implement undo as a bounded in-memory inverse stack (last 100 actions). This costs roughly a day and loses only persistent history across sessions.

Do not run both systems. Pick one and commit.

### Op types

```ts
type Op =
  | { type: 'idea.create';     ideaId: string }
  | { type: 'idea.rename';     ideaId: string; title: string }
  | { type: 'idea.setMeta';    ideaId: string; icon?: string; color?: string; pinned?: 0|1 }
  | { type: 'idea.softDelete'; ideaId: string }
  | { type: 'block.insert';    ideaId: string; blockId: string; blockType: string; orderKey: string }
  | { type: 'block.update';    ideaId: string; blockId: string; data: Record<string, unknown> }
  | { type: 'block.delete';    ideaId: string; blockId: string }
  | { type: 'block.move';      ideaId: string; blockId: string; orderKey: string }
  | { type: 'link.upsert';     ideaId: string; blockId?: string; toTitle: string; toIdeaId: string|null; kind: string }
  | { type: 'board.create';    boardId: string; title: string }
  | { type: 'board.addCard';   boardId: string; columnId: string; cardId: string; ideaId: string; orderKey: string }
  | { type: 'board.moveCard';  cardId: string; toColumnId: string; orderKey: string }
  | { type: 'board.removeCard';cardId: string }
  | { type: 'tag.add';         ideaId: string; tag: string }
  | { type: 'tag.remove';      ideaId: string; tag: string }
```

`block.update` carries only the keys that changed. Full-block replacement would conflict with concurrent edits to different fields of the same block — a common case once you have a text block being typed on two devices.

### Lamport clock

```
ts = max(wall_clock_now, max_seen_ts + 1)
```

Maintained per device, persisted. This makes timestamps monotonic even when the system clock jumps backwards, which it will, because laptops sleep.

---

## 9. Block system

### Registry

Every block type registers into one registry. Adding a type means adding one file and one registry line — no changes to the editor core.

```ts
interface BlockType {
  type: string
  icon: string
  label: string
  keywords: string[]              // slash-menu search
  create(data?: unknown): BlockData
  defaultData(): BlockData
  Component: React.FC<BlockProps>
  /** Human-readable one-line summary, used in board cards and search results. */
  summary(data: BlockData): string
  /** Blob hashes this block references; used by GC. */
  referencedBlobs(data: BlockData): string[]
}
```

Block types to ship: `text`, `sketch`, `image`, `audio`, `file`, `callout`, `embed`. Callouts first if you want something Notion-like cheaply; `embed` (a linked idea rendered inline) is the one most people will screenshot.

### Ordering: fractional indexing

`order_key` is a base-62 string that can always generate a key *between* any two existing keys. Dragging a block therefore never renumbers its siblings and never writes more than one row.

```ts
// Between "a0" and "a1" → "a0V"
// After the last key     → successor("a0V")
// Before the first key   → predecessor("a0")
function keyBetween(a: string | null, b: string | null): string
```

Recommended: the [`fractional-indexing`](https://www.npmjs.com/package/fractional-indexing) package (Rocicorp / Alex Edwards), or hand-roll 40 lines of base-62 midpoint. Don't use floats — they run out of mantissa after ~50 consecutive inserts in the same gap.

**Invariant:** all sibling `order_key` values in an idea are unique. Enforce in `block.insert` / `block.move` by regenerating on collision.

### Text blocks: one TipTap per block

Each text block is an independent ProseMirror document. This is the seam that lets sketches and audio players be atom nodes in a normal document instead of the editor fighting foreign DOM.

- **Markdown shortcuts** on: `#`, `##`, `-`, `1.`, `>`, ``` ``` ``, `---`, `**`, `*`, `` ` ``, `~~`.
- **Slash menu** (`/`) filtered by `BlockType.keywords`, with a keyboard-first palette.
- **Enter** at end → new text block. **Enter** mid-block → split. **Backspace** at start → merge into previous (with a guard: don't merge into a sketch or image; lift the text into a new block instead).
- **Virtualisation is mandatory.** Mount a TipTap editor only for blocks within ~2 viewports. Without this, a 300-block idea has 300 live ProseMirror instances and typing lags visibly.
- **Undo boundary:** each block is its own undo scope. `Mod+Z` inside a block undoes within that block; `Mod+Shift+Z` at the document level is the app-level inverse-op stack.

### Slash menu contents (week 3)

Text, Sketch, Image, Voice note, File, Callout, Embed idea, Divider, Todo, Table (single row), Code block.

Todo and table can share the `text` block type with different TipTap schemas, or be their own block types. **Prefer their own types** — `todo` and `table` as block types with `data_json` holding their content. Reuse of the text schema is what turns a todo into a spreadsheet by accident.

---

## 10. Sketch engine

The wedge feature. Most detailed section in this document because it's the highest-risk and highest-differentiation part.

### Coordinate system

- A sketch block has a virtual coordinate space. Strokes are stored in **sketch space**.
- The canvas element has a **viewport transform**: `{ x, y, scale }`.
- Screen → sketch: `(screen - viewport.origin) / scale`
- Pan: drag with two fingers / space+drag / middle-drag.
- Zoom: pinch / `Cmd+scroll` / `+`/`-`, anchored at the cursor.
- Scale range **0.05× to 40×**. Below 0.05 the strokes are sub-pixel; above 40 there's no detail left to show. Clamp.

### Stroke format

```ts
type Stroke = {
  id: string
  tool: 'pen' | 'marker' | 'eraser'
  color: string          // hex
  size: number           // base width in sketch units
  opacity: number        // 0..1
  points: number[]       // flat [x0,y0,p0, x1,y1,p1, ...], p in 0..1
  bbox: [number, number, number, number]   // precomputed, for culling
  createdAt: number
}
```

**Flat number array, not an array of objects.** A 400-point stroke as objects is ~40KB of JSON overhead; as a flat array it's ~6KB. Quantise coordinates to **2 decimal places** and pressure to **3 significant bits** (levels 0–7) before serialising. Typical measured reduction is 55–70% with no visible quality loss, because perfect-freehand's output is smooth by construction and sub-0.01-unit precision is invisible at any zoom below 40×.

### Rendering

- Plain **Canvas2D**. One `<canvas>` per mounted sketch block, sized to `devicePixelRatio`.
- Redraw only when dirty, via `requestAnimationFrame`.
- **Dirty-rect invalidation:** track the union bbox of strokes that changed since the last frame and clear/redraw only that region, plus one stroke-width margin. Redrawing 2,000 strokes is ~8ms on a modern laptop; it's fine, but a redraw-on-every-pointermove at 120Hz is not.
- Stroke outline comes from perfect-freehand's `getStroke()` which returns closed outline polygons — fill them, don't stroke them. This is what gives pressure-varying width for free.
- Colour alpha and `globalCompositeOperation = 'multiply'` for the marker tool (highlighter behaviour).
- Off-screen strokes only (`bbox` outside viewport after transform) are skipped entirely.

### Tools

| Tool   | Behaviour                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------- |
| Pen    | Pressure-sensitive, thinning 0.6, smoothing 0.5, streamline 0.4, `simulatePressure` on for mouse/touch, off for pen |
| Marker | Flat width, `multiply` blend, 0.35 opacity, thinning 0                                                              |
| Eraser | **Stroke-level** delete: hit-test the topmost stroke under the cursor and remove it wholesale.                      |
| Lasso  | Select N strokes → move / delete / duplicate. Week 9 stretch.                                                       |

**Why stroke-level erase and not pixel erase.** Pixel erase means splitting a stroke at the eraser boundary, which means a much harder stroke model and a visually wrong result (halved line caps). Procreate/Figma do pixel erase because they have a raster layer model. A vector sketch model should erase strokes. If pixel erase is genuinely needed, add it in week 9+ as a separate tool that _deletes or splits_ strokes along the eraser path — do not retro-fit it into the base model.

### Pressure and tilt

`PointerEvent.pressure` (0–1), `pointerType` (`pen` | `touch` | `mouse`), `tiltX` / `tiltY`, and `getCoalescedEvents()` for sub-frame sample fidelity on 120Hz+ pens.

- `simulatePressure: pointerType !== 'pen'` — mice get velocity-derived width so strokes still look hand-drawn rather than uniform.
- `getCoalescedEvents()` matters: without it, a fast stroke on a 240Hz display samples at 60Hz and looks polygonal. This is a 5-line change with a very visible payoff.
- Tilt → shading, not geometry. `tiltX/tiltY` → a subtle opacity or width bias. Do not attempt 3D or perspective.

### Undo

Stroke append is the unit. Undo = pop the last stroke (or re-add a deleted one). Because strokes are immutable once committed, this is O(1) and cannot corrupt.

**In-progress stroke** lives in local component state and is not in the op log until pointerup. Commit on pointerup = one `block.update` op containing the strokes array (or, for large sketches, a `block.appendStroke` op — see below).

### Sketch payload growth

`data_json` for a sketch block holds all strokes. At 400 strokes × ~6KB = 2.4MB of JSON in a single SQLite row, rewritten on every commit. Three mitigations, applied in this order:

1. **Sharded blocks.** After 300 strokes, split into multiple sketch blocks with `continuation: true`. Pure win, invisible to the user, no new concepts. _(ship in week 5)_
2. **`block.appendStroke` op.** Adds one stroke without rewriting the array. Requires the reducer to merge rather than replace. _(week 5, do this regardless — it also makes sync of in-progress sketches cheaper)_
3. **Level-of-detail.** At `scale < 0.3`, replace stroke outlines with their centreline as a single `lineTo` path. 10× faster draw. _(week 5 if profiling demands it)_

### Export

- **SVG** — perfect-freehand outlines are already polygons. Emit `<path d="M…Z" fill="#hex" fill-opacity="…"/>`. Lossless, tiny, embeddable.
- **PNG** — render to an `OffscreenCanvas` at 2× and `convertToBlob`. For pasting into other apps.
- **Both** are `block_blob` rows with `role: 'render'`, generated lazily on first request and cached.

---

## 11. Media pipeline

### Images

```
File / paste / drop
  → read as ArrayBuffer
  → sha256 → hash
  → if blob row exists: skip write entirely (dedupe)
  → write to blobs/<aa>/<hash>.<ext>
  → upsert blob row
  → insert image block, insert block_blob(original)
  → hand off to thumbnail worker
```

**Thumbnail worker** (`workers/thumbnail.worker.ts`):

```ts
const bitmap = await createImageBitmap(file)
const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height))
const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale),
                                   Math.round(bitmap.height * scale))
canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 })
```

WebP at 0.82 is ~30–40% of the PNG size with no visible loss for thumbnails. Fallback to `image/jpeg` if `convertToBlob` with WebP is unsupported.

**Worker concurrency: 2, not `navigator.hardwareConcurrency`.** A burst of 400 dropped photos must not spawn 400 concurrent decodes and OOM. A semaphore of 2 with a queue is the difference between a smooth import and a crashed tab.

**EXIF**: parse orientation tag and apply `createImageBitmap(file, { imageOrientation: 'from-image' })` so phone photos aren't sideways. Strip GPS data from thumbnails (write them without EXIF) — see §18.

### Voice notes

The highest-risk feature in the app. §22 has the risk entry; this is the design.

**Record**

```ts
const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  .find(m => MediaRecorder.isTypeSupported(m))
const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64000 })
```

Chromium (Windows, Linux) gives `webm/opus`. **WKWebView on macOS only supports `audio/mp4` (AAC).** The `find` chain handles both. Store the resolved mime on the blob row so playback picks the right `<source>`.

64kbps mono opus is plenty for speech and is ~480KB/hour. A 40-second voice note is ~320KB.

**Waveform peaks**

Computed once at save, in a worker:

```ts
const ctx = new OfflineAudioContext(1, 1, 44100)
const audio = await ctx.decodeAudioData(arrayBuffer)
const N = 2000                       // fixed bucket count, not per-sample
const step = Math.ceil(audio.length / N)
const peaks = new Int8Array(N)      // -128..127
// fill peaks by max-abs over each bucket
```

Fixed 2000 buckets means a 5-second clip and a 5-hour clip render identically fast. Store as **base64 of the Int8Array** (2000 bytes → ~2.7KB base64) in `data_json`, not as a blob. Base64 in JSON avoids a row per waveform and survives sync for free.

**Cap decode at 10 minutes.** `decodeAudioData` decodes the *entire* file into memory; a 90-minute recording is ~380MB of Float32. If `recording.duration > 600`, downsample during recording: run a second `MediaStreamDestination` through a `ScriptProcessor`/`AudioWorklet` capture that records a live peak array, and skip `decodeAudioData` entirely for long clips. *(Week 8 — only if you actually record long notes. Ship the simple version first.)*

**Playback**: `<audio>` with a custom waveform UI. Click/drag to seek, 1.5× / 2× toggle, keyboard `space` to play/pause. No transcription in the base version (see §24).

**Fallback**: if `getUserMedia` fails (Linux WebKitGTK, permission denied), show a clear message and offer "attach an audio file instead". The app must not break. A `cpal`-based Rust recorder is the week-8 fallback if Linux matters more than it probably does.

### Files

- Any MIME, up to a configurable cap (default 100MB).
- `attach` (bytes are copied into the vault, content-addressed) vs `link` (a reference to a path on disk, stored in `data_json`, no blob). Two genuinely different intents; support both.
- Preview: `image/*` (the image pipeline), `audio/*` (the audio pipeline), `video/*` (native `<video>`), `application/pdf` (iframe), `text/*` (syntax-highlighted read-only, truncate at 2MB), everything else (icon + filename + size).

---

## 12. Blob store

### Layout

```
<vault>/.sketchback/
├── sketchback.db
├── blobs/
│   ├── 3f/
│   │   └── 3fa2b1…9c.png          # 2-hex shard, 3 chars of basename for collision comfort
│   └── a1/
│       └── a1e0d4…bb.webp
└── tmp/
    └── <in-flight uuid>           # staged writes, renamed on completion
```

Writes go to `tmp/` first, then `fs.rename` into place. Rename is atomic on the same filesystem, so a crashed upload never leaves a truncated blob under a hash that claims to be complete.

### Why content addressing

1. **Dedupe** — the same photo dropped in three ideas is stored once.
2. **Sync is a set difference** — `SELECT hash FROM blob` locally, subtract from server. No per-blob bookkeeping.
3. **Integrity** — sha256 verifies a blob survived transfer. A blob that hashes wrong is detectable, not silently corrupt.
4. **Immutable** — never edit a blob in place. "Editing" an image means writing a new blob and repointing the `block_blob` row.

### Reference counting and GC

`block_blob` is the reference graph. GC runs on startup and weekly:

```
1. mark  — every hash reachable from block_blob (respecting deleted_at)
2. mark  — every hash referenced by an unsynced op payload
3. sweep — blobs on disk with no blob row, or blob rows unmarked for >30 days
```

Step 2 matters: a blob created in an op that hasn't synced yet must not be collected. This is a real data-loss bug if you skip it.

Never GC on a schedule during active editing. Startup + manual ("Rebuild storage") only.

---

## 13. Links, backlinks and search

### Wikilinks

`[[Idea Title]]` and `[[Idea Title|alias]]`, typed inside a text block. Interaction model:

- Trigger on `[[`.
- Fuzzy-match against `idea.title`, ranked: exact > prefix > substring > recent.
- Arrow keys + Enter to insert. Escape to dismiss.
- Inserted link is a TipTap mark carrying `data-title`.
- On commit, reconcile the `link` table for that block (delete missing, insert added).

**Unresolved links are first-class.** `[[Something That Doesn't Exist Yet]]` creates a `link` row with `to_idea_id = NULL` and renders in the sidebar's "unlinked / unresolved" list with a *create* button. This is Obsidian's most-loved behaviour and costs about 30 lines.

### Rename cascade

When idea *X* is renamed old → new:

```
UPDATE link SET to_title = ? , to_idea_id = ?
WHERE to_title = ? COLLATE NOCASE AND (to_idea_id = ? OR to_idea_id IS NULL)
```

One indexed statement. Must also rewrite the literal `[[old]]` strings inside text block `data_json`, because the rendered document would otherwise show the stale title. Do that as a `block.update` per affected block, batched into a single op.

**Case-only renames** need the `COLLATE NOCASE` index plus an explicit second pass, because SQLite's `=` is case-sensitive for non-ASCII by default and `NOCASE` only folds ASCII.

### Backlinks

```sql
SELECT l.from_idea_id, i.title, l.block_id, l.kind
FROM link l JOIN idea i ON i.id = l.from_idea_id
WHERE l.to_idea_id = ? AND i.deleted_at IS NULL
ORDER BY i.updated_at DESC
```

Grouped by source idea, showing the *block* that contains the link so the panel can deep-link to it.

### Unlinked mentions

All `[[…]]` wikilinks across every block, minus resolved links. Populated into the `mention` table on block commit (delete-then-insert for that block), so the query is a single indexed scan rather than a JSON scan over every block.

```sql
SELECT DISTINCT m.idea_id, i.title
FROM mention m JOIN idea i ON i.id = m.idea_id
WHERE m.title_lower = ? AND i.id != ? AND i.deleted_at IS NULL
```

### Search

FTS5 over `search(title, body)`. Populated on a 500ms debounce after block commit — the app deletes the idea's row and reinserts. For an idea with 200 text blocks that's one row with concatenated body, which is fast.

```sql
SELECT idea_id, snippet(search, 1, '▸', '▹', '…', 12) AS snip, bm25(search)
FROM search WHERE search MATCH ? ORDER BY bm25(search) LIMIT 40
```

Command palette (`Mod+K`) searches titles, block content, tags, and board names in one ranked list. **This is the primary navigation in the app** — more important than the sidebar. Budget real time for it.

### Tagging

`#tag` inline in text blocks plus a tag field in the sidebar. Tags are flat, no hierarchy. Tag pane lists by count. That's it. Nested tags are a rabbit hole with no payoff here.

---

## 14. Boards

A board is columns of cards; a card **is** an idea. Nothing is copied.

### Rules

1. An idea may appear on a given board **at most once**. Enforced in the app layer at insert time (the DB can't express "at most once per board" because `board_id` isn't on the card row — it joins through `column_id`).
2. Moving a card changes `board_card.column_id`. Because the card points at the idea, the idea's "boards" chip and every link of kind `board` update automatically. **There is no duplicated state.** This is the whole design.
3. Deleting a card unlinks; it never deletes the idea. Deleting an idea cascades its cards (via `ON DELETE CASCADE` from `board_card.idea_id`).

### Card rendering

```
┌──────────────────────────┐
│ ▓▓▓ thumbnail ▓▓▓       │  ← first image or sketch render, 16:9, or none
│ Idea title               │
│ #tag  ·  2 backlinks     │  ← live counts
└──────────────────────────┘
```

Thumbnail pulls from the idea's first `image` or `sketch` block via `block_blob` role `original`/`render`. If neither exists, fall back to a generated monogram tile coloured by the idea's colour. Never show an empty box.

### Drag and drop

- HTML5 DnD is unreliable for cross-column + auto-scroll. Use **pointer events** with a custom drag layer.
- Auto-scroll when the cursor is within 40px of the board edge.
- Drop indicator line between cards.
- `wip_limit` on a column shows a soft warning, never blocks the drop. Hard limits in a thinking tool are hostile.

### Idea-side surface

An idea that's on 3 boards shows 3 chips in its header. Clicking jumps to the card. This is what makes the board↔idea relationship feel like one system instead of two features.

### Board types beyond kanban

Week 9+ stretch: a "gallery" board layout (masonry of idea thumbnails) and a "timeline" layout. Both reuse `board_card`; only the view differs. Cheap if the data model is right, which it is.

---

## 15. Sync protocol

Single user, multiple devices. **No CRDT.**

### Model

- Every device has a `device_id` and a gapless per-device `seq`.
- Every op gets a **server-assigned monotonic `server_seq`** on acceptance.
- Each device stores a cursor: the highest `server_seq` it has pulled.
- `version` table holds, per idea, the highest `seq` seen from each device — a version vector.

### Conflict rule

For a given `block_id`, the winner is the op with the higher `(lamport_ts, device_id)` lexicographically. Lamport timestamp first (so genuine later edits win), device ID as deterministic tiebreak (so both devices converge on the same answer).

**Field-level granularity.** `block.update` ops carry only changed keys. If device A types in a text block while device B changes its colour, both survive. This is why §8 mandates partial payloads.

### Endpoints

```
POST   /v1/auth/token              { email, password }  → { token, device }
POST   /v1/auth/refresh
POST   /v1/push                    { device_id, ops[], blobs[] } → { accepted, rejected[] }
GET    /v1/pull?since=<seq>&limit=500            → { ops[], blobs[], has_more }
GET    /v1/blobs/<hash>            → bytes (immutable, cacheable forever)
HEAD   /v1/blobs/<hash>            → existence check for batch sync
POST   /v1/blobs/check             { hashes[] }       → { present[], missing[] }
GET    /v1/ideas/<id>/export       → full idea JSON (share links, backup)
```

### Push

Client sends ops with `seq` in a contiguous range starting at `last_acked + 1`.

- Server assigns `server_seq` in arrival order.
- Server returns `accepted: {last_server_seq, device_seq_high_water}`.
- **Gaps are rejected** — a device must always push from its own high-water mark. If the server sees a gap it 409s and the client resyncs from scratch.
- Ops are **idempotent** by `id` (uuid). A retried push that overlaps already-accepted ops returns success for the duplicates. This is what makes retry-on-timeout safe.

### Pull

```
GET /v1/pull?since=<server_seq>&limit=500
→ { ops: [...], blobs: [...], has_more: bool }
```

Ops and blobs come back together because an op referencing a blob is useless without it. Client applies ops, then fetches any missing blobs by hash (skipping ones already on disk). This ordering matters: **apply ops only after their blobs are present**, or a sketch block renders empty and looks like data loss.

### Blob sync

Not in the op stream. `POST /v1/blobs/check` with a batch of local hashes returns which are missing; the client uploads those. Hashes are content-addressed so there is no conflict case at all — a blob either matches its hash or is corrupt.

`GET /v1/blobs/<hash>` returns `Cache-Control: public, max-age=31536000, immutable` and `ETag: "<hash>"`. A blob fetched once is never fetched again.

### Offline

Everything is local-first, so "offline" is the default state, not an error state. The sync client is a background loop:

```
every 15s if online and dirty:
  flush pending blobs → flush pending ops → pull
```

Nothing in the UI waits on it. There is a sync indicator in the status bar (idle / syncing / offline / N pending / error) and nothing else. **Do not add a sync modal.**

### What this does *not* do

- No per-field merge of text. Concurrent edits to the *same* text block on two devices resolve last-write-wins, losing one edit. Acceptable for one person; documented in the README.
- No offline CRDT. Tapping into a stale block and typing on device B while A is offline will clobber. Mitigated by showing "this idea changed on <device>" on focus.

---

## 16. Server

Runs on the Hack Club Terra box. Small: Node 22 + Fastify + better-sqlite3, one SQLite file, blobs on disk, one Docker container.

### Schema (server-side)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, created_at INTEGER
);
CREATE TABLE tokens (
  token_hash TEXT PRIMARY KEY, user_id TEXT, device_name TEXT,
  created_at INTEGER, last_used_at INTEGER, revoked_at INTEGER
);
CREATE TABLE ops (
  server_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE, user_id TEXT, device_id TEXT, device_seq INTEGER,
  ts INTEGER, idea_id TEXT, type TEXT, payload_json TEXT
);
CREATE INDEX idx_ops_user ON ops(user_id, server_seq);
CREATE TABLE blobs (
  hash TEXT PRIMARY KEY, user_id TEXT, size INTEGER, mime TEXT, created_at INTEGER
);
```

### Auth

- Argon2id password hash (`argon2` npm package). Never store or log the password.
- On login, mint a per-device random token, store **sha256(token)**, return the plaintext token once. Plaintext is never persisted — a database leak doesn't yield usable tokens.
- Token in `Authorization: Bearer`. Compared with a constant-time function.
- Device list in settings with per-device revoke.
- Rate limit login attempts per IP.

### Blob serving

```
GET /v1/blobs/<hash>
  → validate hash format (^[0-9a-f]{64}$)
  → resolve to blobs/<aa>/<hash>.<ext>
  → stream with Content-Type from the blob row, ETag, immutable Cache-Control
  → 404 if absent (never 403, to avoid leaking existence)
```

Serve from the filesystem, not from SQLite. Do not put blob bytes in the DB.

### Deploy

- `Dockerfile`, single container, SQLite on a **persistent volume**. If the Terra box gives you an ephemeral filesystem, blobs die on every deploy — confirm persistence in week 10 before writing any of this.
- Health endpoint `GET /healthz` → `{ ok, db, disk_free_bytes }`.
- Backup: nightly `sqlite3 .backup` + `tar` of `blobs/`. Ten lines of cron. The data is irreplaceable (it's your thinking).

---

## 17. Import and export

### Obsidian vault import (week 12)

You have a real Obsidian vault, so this is both a feature and your dogfood corpus.

```
vault/
  Note.md              → idea, blocks
  attachments/         → blobs (deduped by hash, so shared images land once)
```

Mapping:

| Obsidian | Sketchback |
|---|---|
| `# H1` | `text` block, heading 1 |
| Paragraph | `text` block |
| `- item` / `1. item` | `todo` or `text` block with list node |
| `> [!note]` | `callout` block, type=note |
| ` ```lang ` | `text` block, code block |
| `[[Other Note]]` | `link` row, kind=wiki |
| `[[Other\|alias]]` | `link` row + alias preserved |
| `![[image.png]]` | `image` block, blob from `attachments/` |
| `![[Note]]` | `embed` block |
| `#tag` | inline tag + `tag` row |
| `%%comment%%` | dropped |
| YAML frontmatter | `idea` metadata (tags → tags, others → JSON in a `meta` block) |
| Dataview / plugins | **not supported**; warn and drop |

Import is **read-only on the source** and reports a summary: N ideas, M links, K unresolved links, J unsupported constructs with file + line. Reporting what was dropped matters more than a silent import.

Performance: 1,000 notes with 400 images. Use the same blob dedupe path so shared attachments are hashed once. Run in chunks of 50 ideas with a progress bar; it should not block the UI thread.

### Export

- **Whole vault** → a directory copy plus a `.zip`. Blob folder + db. Trivially correct.
- **Single idea** → self-contained `.html` with ink inlined as SVG, images base64'd, links rewritten to relative paths. Opens in any browser forever. This is the share format.
- **JSON** → the full idea graph, for scripting and for me to debug bugs from your reports.

### Backups

The vault is a folder. "Back up Sketchback" = copy the folder. On app start, if the last backup is >7 days old, non-destructively nag once. The app should never be the only place something exists.

---

## 18. Security and privacy

This app holds photos, voice recordings, and private thinking. Treat it accordingly.

| Concern | Handling |
|---|---|
| **EXIF GPS in photos** | Strip all EXIF from thumbnails and from any blob served to a share link. Keep the original untouched on disk but never expose it via a public path. |
| **Share links** | Random 128-bit token, not sequential. Read-only at the auth layer (the endpoint has no write path — enforce by construction, not by a flag). Revocable. Optional expiry. Default: strip location data. |
| **At-rest encryption** | Out of scope for v1. Documented honestly. |
| **Password storage** | Argon2id, server-side. Never log credentials. |
| **Token storage** | sha256 in DB; plaintext shown once. |
| **Path traversal** | Blob paths are constructed from a validated `[0-9a-f]{64}` hash and a whitelisted extension. Never interpolate user-supplied filenames into paths. |
| **XSS in note content** | TipTap renders to a sanitised schema; no raw HTML extension. Markdown `![[…]]` resolution is allowlisted against existing blob hashes. |
| **Upload caps** | Configurable, default 100MB per file. Enforced before the blob write, not after. |
| **Sync transport** | HTTPS only. Certificate errors are fatal, not bypassable. |
| **Telemetry** | None. No analytics, no error reporting to any third party. Local file log only, with a "copy diagnostics" button. |

---

## 19. Performance budget

Targets on a 2020-era laptop, 500-block idea, 2,000 photos in the vault:

| Interaction | Budget | Notes |
|---|---|---|
| Keystroke → paint | < 16ms | Never await I/O |
| Cold open, 200-block idea | < 400ms | Block rows only; blobs lazy |
| Open idea with 50 photos | < 800ms | Thumbnails only, originals lazy |
| Scroll with 50 visible images | 60fps | Virtualise; `content-visibility: auto` on blocks |
| Sketch pan/zoom, 500 strokes | 60fps | Dirty-rect |
| Sketch pan, 2,000 strokes | ≥30fps | LOD at <0.3 scale |
| Thumbnail of a 12MP photo | < 400ms | Off-main-thread, concurrency 2 |
| Import 1,000 notes + 400 images | < 60s | Chunked, progress bar |
| Cold start to interactive | < 1.2s | Tauri wins this vs Electron |
| Vault with 10,000 blocks | < 1s search | FTS5 |

Enforce with a real budget, not vibes: mark the long tasks in week 3 and check `performance.mark` in weeks 5, 8, 11.

### Known perf traps

1. **One TipTap per block without virtualisation.** Fatal past ~100 blocks.
2. **Whole-array rewrite on every stroke commit.** Fixed by `block.appendStroke`.
3. **`createImageBitmap` without concurrency cap.** Fixed by semaphore of 2.
4. **Loading full-size images into the lightbox.** Always load a `thumb` until the lightbox is opened.
5. **Re-rendering the whole idea on any op.** Zustand selectors must be per-block. One store slice per block id.

---

## 20. Testing strategy

The testing story is: **almost all the risk is in pure functions, so almost all the tests are pure-function tests.**

| Layer | Tool | What |
|---|---|---|
| Core logic | Vitest | op fold, sync merge/LWW/version vectors, wikilink parse + rename cascade, fractional indexing, peaks, stroke quantisation, obsidian parser |
| Rust | `cargo test` | blob path construction, path traversal rejection, hash verification, prune logic |
| Components | Vitest + Testing Library | slash menu, block toolbar, board DnD |
| E2E | Playwright | 6 critical flows, run against `MemoryPlatform` in a plain browser |
| Manual | — | pen pressure feel, drag smoothness, lightbox, audio sync |

**The `Platform` interface (§4) is what makes the Playwright suite possible.** E2E tests run in Chromium against `MemoryPlatform` — no Tauri build, no Rust, ~2s test suite. Build the actual Tauri app only for the final manual pass.

**Must-have tests (write these, they're cheap and they'll save you):**

```
op.fold.spec.ts           — apply a sequence of ops, assert derived state
op.undo.spec.ts           — apply, inverse, assert equality with pre-state
sync.merge.spec.ts        — two devices, same block, different fields → both survive
sync.lww.spec.ts          — same field → deterministic winner on both sides
links.rename.spec.ts      — rename cascades to inbound links and to block text
links.case.spec.ts        — case-only rename
orderKey.spec.ts          — keyBetween never collides, always ordered
peaks.spec.ts             — correct bucket count, correct max-abs, silence-safe
sketch.quantize.spec.ts   — round-trip preserves bounds within epsilon
obsidian.parse.spec.ts    — fixture vault → expected block tree
```

A property-based test on `keyBetween` with fast-check is worth 20 minutes and will find the collision you didn't think of.

---

## 21. Week-by-week plan

12 weeks × 20h = 240h. Every week ends with something demoable. If a week slips, take the cut ladder in §23, not the schedule.

---

### Week 1 — Foundation

**Goal:** an app that opens a vault and lets you create, rename, and reopen ideas.

| Task | h |
|---|---|
| Rust + Tauri v2 scaffold, dev + release build on your primary OS | 4 |
| Vite + React 19 + TS + Tailwind 4; confirm HMR works in the Tauri webview | 2 |
| `Platform` interface + `MemoryPlatform` + `TauriPlatform` skeleton | 3 |
| SQLite schema (full DDL from §7) + migration runner | 3 |
| Vault open/create, idea CRUD, sidebar list, route to `/idea/:id` | 4 |
| Command palette skeleton (`Mod+K`), basic keyboard nav | 2 |
| Repo init, `.gitignore`, first commit, README stub | 1 |
| **Set up Hackatime properly.** Journal entry for the week | 1 |

**Acceptance:** `git clone` your repo, build it, create 20 ideas, kill the app, relaunch, all 20 are there. Hackatime dashboard shows `sketchback` accumulating time.

**Watch:** Tauri v2's capability/permission model. Missing permissions fail *silently* in some versions — a `fs` call that returns null is usually a missing scope in `capabilities/default.json`, not a bug.

---

### Week 2 — Block editor core

**Goal:** type in an idea like Notion.

| Task | h |
|---|---|
| Block registry, block store, `order_key` (fractional indexing) + tests | 4 |
| Block container: render list, keyboard nav (↑↓ Home End Mod+Home), selection | 3 |
| Text block: TipTap instance, markdown shortcuts, split/merge | 4 |
| Slash menu with keyboard-first navigation | 3 |
| Op creation + fold for text ops; **wire up undo/redo** | 3 |
| Drag-to-reorder blocks | 2 |
| Create the Pixl project on pixl.hackclub.com pointing at Hackatime project `sketchback` | 1 |

**Acceptance:** write 400 words in one idea; reorder 10 blocks by dragging; `Mod+Z` undoes the last action; reopen and the order persisted.

**Journal:** screenshot the first time the slash menu feels fast. That's your baseline for everything after.

---

### Week 3 — Op log decision point + persistence

**Goal:** make the core architecture decision and stress it.

| Task | h |
|---|---|
| Complete op types for ideas/blocks; fold into state | 4 |
| Sync-safe payload shapes; partial `block.update` | 3 |
| Undo/redo across blocks (inverse op stack) | 3 |
| Block virtualisation (only mount visible blocks) | 4 |
| Performance pass: 300-block idea, profile, fix the top 2 hotspots | 3 |
| Vitest harness against `MemoryPlatform`; write `op.fold`, `op.undo`, `orderKey` tests | 2 |
| Rough UI pass — this is the week the app stops looking like a demo | 1 |

**Acceptance:** a 300-block idea types at 60fps. `op.fold` and `op.undo` suites green.

**⚠️ DECISION GATE (end of week 3, moved up from week 4).** Keep the op log or fall back to row updates + change log. Decide here, while it's cheap.

---

### Week 4 — Persistence + text polish

**Goal:** ideas survive everything, and text feels good.

| Task | h |
|---|---|
| Wire real SQLite through `TauriPlatform`; migrations run on first launch | 4 |
| Idea rename cascade; rename propagation into block text | 3 |
| Idea metadata: title, icon, colour, pin, delete, archive | 2 |
| Search: FTS5 populate on debounce + title search | 4 |
| Command palette: full-text search, ranked, keyboard-only | 4 |
| `links.rename`, `links.case` tests | 2 |
| Journal + Pixl reflection | 1 |

**Acceptance:** rename an idea, click any link to it from anywhere, land on the new title. Search finds text inside a block and takes you to the exact block.

---

### Week 5 — Sketches I 🔥

**Goal:** draw in an idea with a pen.

| Task | h |
|---|---|
| `SketchBlock` component, canvas sizing at DPR, viewport transform | 3 |
| perfect-freehand integration; pen/mouse `simulatePressure` | 3 |
| `getCoalescedEvents` for high-refresh pens | 1 |
| Pan (two-finger / space+drag / middle) and zoom (pinch / `Cmd+scroll`), anchored at cursor | 3 |
| Tools: pen, marker (multiply), eraser (stroke-level) | 2 |
| `block.appendStroke` op; stroke quantisation + bbox | 3 |
| Dirty-rect invalidation | 2 |
| SVG + PNG export, cached as `role: 'render'` | 2 |
| Sketch stress test: 500 strokes, pan at 60fps | 1 |

**Acceptance:** sketch a full UI mockup in an idea, zoom to 20× and back with no visible degradation, export to SVG, undo 10 strokes and redo them.

**This is your demo moment.** If by Friday you can't draw smoothly, cut boards and files for the rest of the project — not this.

---

### Week 6 — Images 🔥

**Goal:** photos in ideas, fast.

| Task | h |
|---|---|
| Blob store: content addressing, atomic write via tmp+rename, sharding | 4 |
| Image pipeline: drop / paste / picker → dedupe → blob → block | 3 |
| Thumbnail worker: OffscreenCanvas, WebP, semaphore of 2 | 3 |
| EXIF orientation; strip EXIF from derivatives | 2 |
| Image block: lazy loading, caption, alt text, remove | 2 |
| Lightbox: full-screen, arrow keys, zoom, `Esc` | 3 |
| Sidebar idea list shows a cover thumbnail | 2 |
| Drag 200 photos into one idea; verify memory stays flat | 1 |

**Acceptance:** drop 200 photos into one idea. It doesn't freeze, doesn't OOM, opens in under a second, and re-importing the same 200 photos adds zero new blobs.

---

### Week 7 — Voice notes + files

**Goal:** talk to your phone, and the clip lives in the idea forever.

| Task | h |
|---|---|
| `Platform.mic`; permission flow; mime detection with the mp4 fallback chain | 3 |
| Recorder UI: record button, elapsed timer, waveform live preview | 3 |
| Stop → blob → audio block | 2 |
| Peaks worker: `decodeAudioData` → 2000 Int8 buckets → base64 | 3 |
| Waveform player: seek by click/drag, 1.5×/2×, keyboard transport | 4 |
| Graceful mic-unavailable path (Linux, permission denied) | 2 |
| Generic file block: attach vs link, preview by type, download | 2 |
| Journal | 1 |

**Acceptance:** record a 40-second voice note on macOS **and** Windows; it plays back on both, and the waveform matches. If macOS requires an `Info.plist` microphone key, this is where you'll find out — budget the afternoon.

---

### Week 8 — Links, backlinks, mentions

**Goal:** the graph exists.

| Task | h |
|---|---|
| Wikilink autocomplete in text blocks (`[[`, fuzzy, keyboard) | 4 |
| `link` reconciliation on block commit | 2 |
| Unresolved links + "create this idea" in sidebar | 2 |
| Backlinks panel with per-block deep links | 3 |
| Unlinked mentions via `mention` table | 2 |
| Tags: inline `#tag`, tag pane | 2 |
| Graph view (stretch pulled forward if ahead) | 2 |
| Journal | 1 |

**Acceptance:** type `[[` and get a live list. Create a link to a nonexistent idea, create that idea, watch the link resolve itself.

---

### Week 9 — Boards 🔥 + polish sprint

**Goal:** boards, then stop adding features.

| Task | h |
|---|---|
| Board/column/card CRUD + migrations | 3 |
| Board view, drag between columns, auto-scroll, drop indicator | 4 |
| Card thumbnails from idea's first image/sketch; monogram fallback | 2 |
| Idea-side board chips ("on 2 boards") | 2 |
| WIP soft warnings | 1 |
| `[[wikilink]]`-based board links | 1 |
| **Polish sprint: empty states, loading states, error states, keyboard shortcuts help sheet** | 4 |
| Journal | 1 |

**Acceptance:** drag a card from *Inbox* to *Shipping*; the idea's chips update; search finds the idea; everything is still coherent on the board's other columns.

**🔒 HARD RULE FROM HERE: no new features.** Weeks 10–12 are sync, integration, and feel.

---

### Week 10 — Server + first sync

**Goal:** the server exists and a second device can push.

| Task | h |
|---|---|
| Server: Fastify, SQLite schema, Argon2 auth, tokens | 4 |
| `POST /push`, `GET /pull`, idempotency, gap rejection | 4 |
| Blob endpoints + `POST /blobs/check` | 3 |
| Client sync loop: 15s, background, never blocking UI | 4 |
| Apply-pulls-in-order; fetch missing blobs before applying ops | 3 |
| **Kill criterion check** | 2 |

**Kill criterion:** if local push/pull is not solid by Friday, **stop**. Ship without sync. Replace it with "Export vault" (zip + self-contained HTML), which is 4 hours instead of 40. Sync is a feature; polish is what makes people care.

**Also confirm here:** does the Terra box have a **persistent volume**? If blobs don't survive a redeploy, the whole sync design changes and you need to know now, not in week 11.

---

### Week 11 — Merge, share links, hardening

**Goal:** two devices converge, and you can share an idea with a human.

| Task | h |
|---|---|
| LWW merge + version vectors; `sync.merge` / `sync.lww` property tests | 4 |
| Conflict surface: "changed on <device>" notice, side-by-side resolve | 3 |
| Read-only share links: 128-bit token, revoked, expiring | 3 |
| Public viewer: idea as self-contained HTML with SVG ink | 3 |
| Schema freeze — no more migrations after this | 2 |
| Backup: nightly sqlite `.backup` + blob tar, and a "restore from backup" command | 2 |
| Journal | 1 |

**Acceptance:** edit the same idea on laptop and desktop alternately for 20 operations with the network randomly off. Both converge to identical state. No data loss outside simultaneous same-block editing.

---

### Week 12 — Ship

**Goal:** someone else can install it and use it.

| Task | h |
|---|---|
| Obsidian vault importer + unsupported-construct report | 4 |
| Import your real vault; fix every crash it finds | 2 |
| Onboarding: 3-panel first-run, vault picker, empty states | 3 |
| Perf pass against §19 budget; fix the two worst offenders | 3 |
| `tauri-plugin-log` + "copy diagnostics" (no third-party telemetry) | 1 |
| Auto-updater with minisign key, or a documented manual-update fallback | 2 |
| README: install, run, build, architecture, honest limitations | 2 |
| Pixl submission: thumbnail, demo link, journal, **AI disclosure** | 3 |
| Record a 90-second demo video | 1 |
| Tag `v1.0.0`, build installers, publish release | 2 |

**Acceptance:** a stranger installs it, creates an idea, sketches on it, drops a photo, records a note, links two ideas, and puts it on a board — without asking you anything.

---

## 22. Risk register

| # | Risk | Likelihood | Impact | Mitigation | Trigger to act |
|---|---|---|---|---|---|
| 1 | **`getUserMedia` fails in Tauri webview.** macOS needs `NSMicrophoneUsageDescription`; Linux WebKitGTK is unreliable | **High** | Voice notes dead | `MediaRecorder.isTypeSupported` chain; graceful degradation to file attach; `cpal` Rust fallback | If not working by Thursday of week 7 |
| 2 | **Op-log fold becomes a debugging swamp** | Medium | Rework cost | Hard decision gate at end of week 3; fallback fully specified in §8 | Gate passes badly |
| 3 | **Rust blocks progress** | Medium | 1–2 weeks | ~400 lines only; switch to Electron costs ~1 week | If Rust blocks you twice in one week |
| 4 | **One TipTap per block doesn't scale** | Medium | Idea open time | Virtualise from week 2; never mount offscreen editors | Profile at week 3 |
| 5 | **Blob GC deletes unsynced data** | Low | **Data loss** | Never GC during active editing; mark unsynced op payloads (step 2 of §12) | Always |
| 6 | **Sync conflict loses a week** | Medium | Schedule | Kill criterion at end of week 10; export fallback specified | Week 10 Friday |
| 7 | **Terra volume is ephemeral** | Medium | Sync design change | Verify in week 10, before writing server code | Week 10 |
| 8 | **Thumbnailing 400 photos OOMs** | Medium | Import fails | Semaphore of 2, chunked, progress UI | On first 200+ drop |
| 9 | **Scope creep into collab/plugins** | High | Everything | Non-goals in §2; hard feature freeze at week 9 | Any PR/idea that violates §2 |
| 10 | **Pen feel is bad and you can't tell without hardware** | Medium | Wedge feature underdelivers | Get a pen in week 1; test pressure/stylus weekly from week 5 | Week 5 |
| 11 | **Self-review blindness** | High | Product is wrong | Dogfood daily from week 1; keep a friction log in `JOURNAL.md` | Always |
| 12 | **Pixl requirements change** | Low | Admin rework | Re-read ship rules at week 11 | Week 11 |
| 13 | **Migrating off the Pixl project name later** | Low | Orphaned hours | Name is frozen at `sketchback`; never change it | — |

---

## 23. Cut ladder

If you're behind, cut in this order. No debate, no re-litigating.

1. Voice-note **transcription** (never built in v1 anyway)
2. **Sync** → replace with export/zip (week 10 kill criterion)
3. **Share links**
4. **Graph view**
5. **File previews** (keep attach, drop the PDF/text viewers)
6. **Tags**
7. **Obsidian importer**
8. **Auto-updater** → documented manual update
9. **Multiple boards per idea** (allow one board per idea instead)
10. **WIP limits**
11. **Milestone blocks** (todo, table)

### Never cut

Sketches, images, voice notes, backlinks, wikilinks, boards (basic kanban), search, offline-first.

**Rule:** the cut ladder only applies to weeks 8 onward. Weeks 1–7 are the product.

---

## 24. Stretch list

Only if you're ahead of schedule at a week boundary. Ordered by value-per-hour.

1. **Self-hosted Whisper on the Terra box** transcribing voice notes into inline editable text under the clip. The single highest-impact stretch item — voice notes become searchable.
2. **Obsidian importer** pulled forward to week 9 (if you want the dogfood benefit earlier)
3. **Gallery and timeline board layouts** (data model already supports it — view only)
4. **Idea tabs** — several ideas open at once in a tab strip above the editor, each tab
   holding its own scroll position and open blocks. The router is already one route per
   idea, so this is a strip plus a list of open ids, not a routing rewrite. The sidebar
   stays the index; tabs are the working set.
5. **Lasso select** in sketches (move / duplicate / delete stroke groups)
6. **Filesystem watch** — drop a file into the vault folder, app notices and imports it
7. **Tauri mobile** (iPad/Android) sharing the React codebase, sketches only
8. **Daily notes** — an idea auto-created for today, `#daily` tagged
9. **Export an idea as a self-contained `.html`** with ink inlined as SVG (pull forward from week 11 if share links get cut)
10. **Plugin API** — expose the block registry

---

## 25. Pixl compliance

Pixl (pixl.hackclub.com) is a pixel-themed YSWS: tracked Hackatime hours become pixels, pixels unlock real-world rewards. Requirements for a software ship:

| Requirement | Where this plan covers it |
|---|---|
| Public GitHub repo, real commit history | Week 1 |
| Working demo link / installable build | Week 12 release + demo video |
| Tracked Hackatime hours | `sketchback` on hackatime.hackclub.com |
| Pixl project pointing at the Hackatime project by exact name | Week 2 |
| Thumbnail image | Week 12 |
| Journal entries per session | `JOURNAL.md`, every week |
| AI disclosure notes | Keep a running `docs/ai-notes.md` from week 1 |
| Eligibility checkbox (not school homework, not duplicate YSWS work) | Confirmed |

**Critical:** the Pixl project's "Hackatime project name" field must read exactly `sketchback`, matching `.wakatime-project`. A mismatch means hours log to your account but never reach the Pixl project, silently.

**If solo:** you link your own Hackatime project and are credited for the hours you personally logged.

**AI disclosure:** this plan was written with AI assistance (an LLM agent). Be straightforward about where it was used — scaffolding, test generation, code review, this document — versus where you made the calls. Reviewers read vague disclosures badly and honest ones fine.

---

## 26. Open questions

Resolve these as they come up; each has a default already chosen so you're never blocked.

| Question | Default | Decide by |
|---|---|---|
| Sketch block: separate document, or a block that can be full-width / full-screen? | Separate block, with a full-screen expand | Week 5 |
| Do boards sync, or are they local-only? | Sync (`board.*` ops exist) | Week 10 |
| Vault = one folder. Support multiple vaults in the UI? | Single vault for v1; schema already allows it | Week 12 |
| Does the sidebar show a cover image per idea? | Yes, first image or sketch | Week 6 |
| Tab key inside a code block: indent or exit block? | Indent; `Esc` then `Tab` exits | Week 3 |
| Electron fallback — is it still acceptable at week 5? | Yes, one week | Week 5 |
| Ink colour palette: fixed swatches or full picker? | 8 fixed swatches + custom | Week 5 |
| Does `[[wikilink]]` resolve by title only, or also by alias? | Title, plus alias match | Week 8 |

---

## Appendix A — Hour budget summary

| Week | Theme | h |
|---|---|---|
| 1 | Foundation | 20 |
| 2 | Block editor | 20 |
| 3 | Op-log **decision gate** + virtualisation | 20 |
| 4 | Persistence, rename cascade, search | 20 |
| 5 | **Sketches** | 20 |
| 6 | **Images** | 20 |
| 7 | Voice notes + files | 20 |
| 8 | Links, backlinks, mentions | 20 |
| 9 | **Boards** + polish sprint, feature freeze | 20 |
| 10 | Server + sync (**kill criterion**) | 20 |
| 11 | Merge, share links, backup, schema freeze | 20 |
| 12 | Import, onboarding, perf, **ship** | 20 |
| | **Total** | **240** |

## Appendix B — Definition of "demoable" per week

| Week | The demo |
|---|---|
| 1 | Ideas persist across a restart |
| 2 | Notion-style typing and slash menu |
| 3 | 300-block idea at 60fps |
| 4 | Rename propagates; full-text search |
| 5 | **Sketch a mockup, zoom to 20×** |
| 6 | **Drop 200 photos, no freeze** |
| 7 | **Record and play a voice note** |
| 8 | `[[` autocomplete, backlinks appear |
| 9 | **Kanban board over ideas** |
| 10 | Two devices sync |
| 11 | Conflict-free offline edits; share link opens in a browser |
| 12 | A stranger installs and uses it |
---

## 27. Design system and preferences

The visual language is deliberately quiet. This is a tool you stare at for hours while thinking about something else, so the chrome should recede and the content should not.

### Principles

1. **Ink is the only thing allowed to be saturated.** Every other surface is neutral. If a colour appears in the UI, it is either user content (a photo, a sketch) or a state (error, unsynced). Decorative colour is a bug.
2. **One accent, used sparingly.** A single hue for focus rings, active nav, and primary buttons. Nothing else. A second accent reads as "someone needed a button and we had a spare colour."
3. **Density is a preference, not a default.** Some days you want twelve blocks on screen; some days you want four big ones. This is a real setting (§27.4), not a theme.
4. **Motion explains, never decorates.** A block appearing is fine. A block bouncing is not. Duration budget: 120ms for state changes, 200ms for layout shifts, 0ms for anything the user caused by typing.
5. **Typography does the work.** One interface family, one mono family, and a scale with exactly six steps. A seven-step scale is a sign someone added a feature without deciding where it belonged.

### Type scale

| Token | Size / line height | Use |
|---|---|---|
| `text-xs` | 11 / 16 | Metadata, timestamps, block-type labels |
| `text-sm` | 13 / 20 | Secondary UI, board card meta |
| `text-base` | 15 / 24 | **Body.** Block text, idea body copy |
| `text-lg` | 18 / 28 | Idea titles in reading view |
| `text-xl` | 22 / 32 | Empty states, onboarding headings |
| `text-2xl` | 28 / 36 | Lightbox caption, share page title |

Body at 15/24 is the important number. It is large enough to sketch against on a tablet and small enough that a 700-word idea does not scroll for a minute.

### Colour tokens

Semantic only, never literal. Components reference `surface-raised`, never `#ffffff`.

| Token | Light | Dark | Notes |
|---|---|---|---|
| `surface-base` | `#faf9f7` | `#16161a` | Warm off-white, not pure white. Pure white on ink-heavy content is glaring. |
| `surface-raised` | `#ffffff` | `#1e1e23` | Cards, menus, the sketch canvas surround |
| `surface-sunken` | `#f0efec` | `#101014` | Code blocks, waveform track, board columns |
| `border-subtle` | `#e5e2dc` | `#2a2a31` | Hairlines. One physical pixel, never two. |
| `text-primary` | `#1c1b19` | `#e8e6e3` | |
| `text-secondary` | `#6b6862` | `#9a978f` | Timestamps, counts |
| `accent` | `#3b6ea5` | `#7aa8d8` | Focus rings, active nav, primary buttons |
| `danger` | `#a5453b` | `#d1706a` | Destructive actions, sync errors only |

**Dark mode is not an inversion.** Dark mode gets its own accent because the same blue that reads as "calm and clickable" on `#faf9f7` vibrates against `#16161a`. Ship light first; the token table above is the contract that makes dark mode a day-3 job rather than a rewrite.

### Elevation

Two levels, expressed as border plus shadow, never as a shadow alone:

- **Level 0** — flat. Everything inside a surface.
- **Level 1** — menus, popovers, dragged board cards. `border-subtle` + `0 4px 12px rgb(0 0 0 / 0.08)`.
- **Level 2** — modals, lightbox. Above level 1, plus a scrim at `rgb(0 0 0 / 0.35)`.

A blurred backdrop is tempting and expensive: it forces a compositing pass on every frame the menu is open, which is exactly the frame the sketch is trying to hit 60fps on. Skip it.

### Spacing

A 4px base grid, with `gap-2` (8px) as the default rhythm between blocks in an idea. Block vertical padding is 2px, not 8px — the document should feel like a page, not a stack of cards. Cards *are* cards and get 12px.

### Motion tokens

```ts
export const motion = {
  instant:  0,
  fast:     120,  // hover, focus, active states
  normal:   200,  // menus opening, panel resizes
  slow:     320,  // lightbox in/out only
}
```

All easing is `cubic-bezier(0.2, 0, 0, 1)`. Respects `prefers-reduced-motion: reduce` by collapsing every token to `instant` except opacity, which goes to 100ms.

### Iconography

Lucide, 16px stroke-1.5 in UI, 20px stroke-2 in block toolbars, 14px for inline marks. Icons never carry meaning alone — an icon-only button needs a tooltip *and* an `aria-label`. Block type icons live in one 24px grid so the slash menu does not reflow as you type.

---

## 28. Preferences, in depth

Preferences are a `prefs` table keyed by name, not a JSON blob, so a schema change never requires rewriting every row.

```sql
CREATE TABLE prefs (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,   -- JSON-encoded scalar or small object
  updated_at  INTEGER NOT NULL
);
```

### Precedence

1. CLI flag (`--density=compact`)
2. Environment variable (`SKETCHBACK_DENSITY=compact`)
3. `prefs` row
4. Built-in default (the `DEFAULT_PREFS` object in `core/prefs.ts`)

The UI writes `prefs`. Nothing else does. Reading is a plain indexed lookup, memoised in a Zustand store keyed by name.

### The preference surface

| Key | Type | Default | Notes |
|---|---|---|---|
| `theme` | `'light' \| 'dark' \| 'system'` | `system` | `system` follows `prefers-color-scheme` live |
| `density` | `'compact' \| 'cozy'` | `cozy` | See below |
| `fontFamily` | string | platform UI font | |
| `bodyFontSize` | number | `15` | Clamped 13–20 |
| `editorFontSize` | number | `14` | The mono/code size |
| `accent` | hex or `null` | `null` | `null` = the theme default |
| `inkPalette` | hex[] | 8 defaults | Max 12 entries |
| `defaultInkWidth` | number | `2.5` | |
| `pressureSensitivity` | number | `0.5` | 0 = width ignores pressure |
| `smoothInk` | boolean | `true` | Off = raw polyline, useful for low-end tablets |
| `snapToGrid` | boolean | `false` | |
| `gridSize` | number | `8` | |
| `showLineNumbers` | boolean | `true` | Code blocks |
| `linkAutocomplete` | boolean | `true` | `[[` suggestions |
| `spellcheck` | boolean | `true` | |
| `autoSaveDelay` | number | `500` | ms, debounce for text commits |
| `confirmDelete` | boolean | `true` | |
| `trashEnabled` | boolean | `true` | Soft delete is the op; this is only the UI affordance |
| `defaultBoardType` | string | `kanban` | |
| `cardShowsCover` | boolean | `true` | |
| `syncEnabled` | boolean | `false` | |
| `syncEndpoint` | string \| null | `null` | |
| `syncInterval` | number | `30` | seconds |
| `telemetry` | boolean | `false` | There is none. The key exists to make that explicit. |

### Density

Density is not a font-size multiplier — it is a set of four independent values, because a person who wants more blocks on screen usually also wants less padding around each one, but not always.

| | `compact` | `cozy` |
|---|---|---|
| Block vertical padding | 1px | 4px |
| Block gap | 4px | 8px |
| Block toolbar | Hover-revealed, 24px | Always-visible-on-focus, 28px |
| Sidebar row height | 26px | 32px |
| Board card padding | 8px | 12px |

### Export and reset

Settings exports to `sketchback-prefs.json` via the same share-sheet machinery as a vault export (§17). A **Reset to defaults** button lives at the bottom, behind a confirm that names the count of preferences being reset, because "reset" that silently nils your accent colour is a bad afternoon.

---

## 29. Keyboard reference

A note-taking app is unusable without a complete keyboard layer. This is the contract; `?` opens it in-app.

### Global

| Keys | Action |
|---|---|
| `Mod+K` | Command palette |
| `Mod+P` | Quick switcher (fuzzy over idea titles) |
| `Mod+N` | New idea |
| `Mod+Shift+N` | New board |
| `Mod+B` | Toggle sidebar |
| `Mod+\` | Toggle zen mode (content only) |
| `Mod+Shift+F` | Search |
| `Mod+,` | Settings |
| `Mod+Z` / `Mod+Shift+Z` | Undo / redo |
| `?` | Keyboard help |
| `Esc` | Close topmost transient (menu → modal → lightbox) |

`Mod` is `Cmd` on macOS, `Ctrl` everywhere else. The palette surfaces bindings with the right glyph per platform, resolved at render time.

### Block editing

| Keys | Action |
|---|---|
| `/` | Slash menu |
| `[[` | Wikilink autocomplete |
| `Enter` | New block (or split at cursor) |
| `Shift+Enter` | Soft break within the block |
| `Backspace` at start | Merge into previous |
| `Mod+Shift+Up` / `Down` | Move block |
| `Mod+A` | Select block, then extend to siblings |
| `Mod+/` | Toggle comment block |
| `` ``` `` | Toggle code block |
| `Tab` / `Shift+Tab` | Indent / outdent (lists, code) |

### Sketch

| Keys | Action |
|---|---|
| `1`–`5` | Pen, marker, highlighter, eraser, select |
| `[` / `]` | Decrease / increase brush size |
| `Space` (held) | Temporary pan |
| `Mod+Z` / `Mod+Shift+Z` | Undo / redo stroke |
| `Mod+A` | Select all strokes |
| `Mod+C` / `Mod+X` / `Mod+V` | Copy / cut / paste strokes |
| `0` | Zoom to fit |
| `1`–`4` with `Mod` | 100 / 200 / 400 / 800% |
| `Mod+S` | Export PNG or SVG |

### Boards

| Keys | Action |
|---|---|
| `Enter` on column header | Add card |
| `Space` on card | Pick up (keyboard drag) |
| `←` / `→` | Move card between columns while held |
| `Enter` on card | Open the idea |
| `Backspace` on card | Remove from board (idea survives) |

Every pointer interaction above has a keyboard equivalent. This is a hard rule, not an aspiration — if a board card cannot be moved without a mouse, the board is not finished.

---

## 30. Onboarding and first-run

The first five minutes decide whether this app gets opened a sixth time. Budget 6 hours for it in week 12; it is worth more than 6 hours of features.

### First-run flow

1. **Pick a vault.** Real folder picker, with the app's data directory offered as a default for people who just want to try it.
2. **Name it.** One text field, one button. No account, no tour, no "what are you here for?" questionnaire.
3. **Land in an idea that already exists.** Seed a single idea titled `Welcome to Sketchback` containing three blocks: a text block explaining the block model, a sketch block with a pre-drawn stroke, and a text block with three `[[wikilinks]]` to three seeded ideas (`Blocks`, `Sketches`, `Boards`) so backlinks are visible in the first ten seconds.
4. **A dismissible hint strip** at the top of the editor: "Press `/` for blocks · `Mod+K` for commands · `?` for keys." Disappears permanently once the user has inserted a non-text block.

No modal onboarding carousel. No "what are you here for?" dropdown. A first-run experience that asks questions before showing the product is a confession that the product doesn't explain itself.

### Empty states

Every empty surface teaches the gesture that fills it.

| Surface | Message | Action |
|---|---|---|
| No ideas | "Nothing here yet." | `Mod+N` hint |
| Empty idea | "Type, or press `/`" | Caret already blinking |
| No backlinks | "No ideas link here yet." | `[[` hint |
| No search results | "No matches for "sketch"" | Suggests the closest title |
| Empty board column | — | Click-to-add only, no text |

### The dogfood rule

From week 1, the real vault is the development vault. Not a `test.nodb`, not a fixture — the actual notes. Every friction logged in `JOURNAL.md` with a date and a one-line repro. Risk 11 in §22 is about self-review blindness, and the only mitigation that actually works is using the thing daily and writing down what annoyed you.

---

## 31. Onboarding the pen, the canvas, and pressure

The sketch layer is wedge one. It either feels like paper or it doesn't, and "doesn't" is unrecoverable in a demo.

### The feel target

- **Latency:** pen-down to first painted pixel under 16ms. Measure it; do not assume it.
- **Line quality:** no visible polygonal corners at 1× zoom with a slow stroke.
- **Taper:** pressure 0 → 0.2 produces a visible thin-to-thick transition. This is the single detail people notice without knowing they're noticing it.
- **No smoothing lag:** a fast stroke should lag the pen by nothing, even with smoothing on. Smoothing must be one-frame, not N-frame.

### Pressure

`PointerEvent.pressure` is the primary source. It is `0.5` for mouse and pen-without-pressure in most browsers, and `0` on `pointerup`.

```
width = base * (1 - sensitivity + sensitivity * pressure^0.7)
```

The `0.7` exponent flattens the low end so light touches still leave a visible line. Without it, the first millimetre of every stroke disappears.

**Fallback chain**, in order:

1. `event.pressure !== 0.5 || pointerType === 'pen'` → trust pressure
2. `pointerType === 'touch'` → use `touch.radiusX/Y` if non-zero
3. Otherwise → constant width, and set a prefs flag so the UI can say "your input device doesn't report pressure"

Detect once at boot, show a one-line note in settings if degraded. Silent constant-width ink looks like a bug; a note that says "mouse detected" looks like a decision.

### Tilt

`tiltX`/`tiltY` in degrees, -90..90. When |tilt| > 30°, widen the stroke by up to 1.4× and flatten it slightly. Used for broad shading, not for line weight. Cheap to add, and the thing that makes a stylus feel like a real tool.

### Palm rejection

`pointerType === 'touch'` events are ignored while a pen has been seen within the last 2 seconds. This is the standard heuristic and it works. Additionally, the eraser end of the stylus reports `button === 5` and `buttons === 32` on Wacom drivers — support it, it is three lines.

### The week-5 pen test

Every week from 5 onward, before anything else:

- Draw a spiral with varying speed.
- Write one line of handwriting.
- Draw a shaded area with tilt.
- Erase with the pen's eraser end.

If any of these feel wrong, the sketch wedge is not done, no matter what the test suite says.

---

## 32. Accessibility

Not a compliance checkbox. A note-taking tool that a person cannot operate is broken for them, permanently.

### Targets

- All interactive elements ≥ 24×24 CSS px, with ≥ 44px hit area where space allows.
- Focus visible at 2px with a 2px offset. Never `outline: none` without a replacement.
- Full keyboard operability of every surface (§29).
- Focus is not trapped except in genuine modals, and `Esc` closes them.

### Screen readers

This is the hardest part and the most likely to be cut. Stated honestly:

| Surface | Target | Realistic |
|---|---|---|
| Idea body (text blocks) | Fully readable in order | **Yes** — TipTap maps to semantic HTML |
| Board (kanban) | Lists and counts | **Yes** — columns as lists, cards as links |
| Backlinks | Readable | **Yes** |
| Search results | Readable | **Yes** |
| Sketch canvas | Described, not read | Partial — `role="img"` + generated description |
| Waveform | Playable, seekable | Partial — a real slider |
| Drag and drop | Has a keyboard path | **Yes** — `Space` to pick up (§29) |

A sketch gets `role="img"` with an `aria-label` built from stroke count, bounds, and whether it contains text-like strokes. That is honest: a drawing is not a document, and pretending otherwise is worse than summarising it.

### Announcements

An `aria-live="polite"` region announces: block type changes, sync state changes, board card moves, and save errors. Deliberately *not* every keystroke — announcing a live region per character makes the app unusable with a screen reader on.

### Colour

Every state that uses colour also uses an icon, a label, or a shape. Unsynced is a cloud-with-a-dot, not just a colour shift. Contrast ≥ 4.5:1 for body text, ≥ 3:1 for UI borders and focus rings, in both themes. Verify both — dark mode failing contrast is the most common accessibility regression in apps like this.

### Reduced motion, zoom, and contrast

`prefers-reduced-motion` collapses the motion table (§27). Browser zoom to 200% must not clip content; the three-column layout collapses to one at a container query width, not a fixed breakpoint. `prefers-contrast: more` bumps border weights and surface separation.

---

## 33. Failure modes and recovery

The unglamorous section that decides whether the app is trustworthy at week 12.

### Every failure needs three things

1. **A message that says what happened and what still works.**
2. **A path forward** — retry, export, or a specific instruction.
3. **A log line** with the op id or blob hash, so a bug report is actionable.

```
Bad:  "Something went wrong."
Good: "Couldn't save this sketch — the vault folder isn't writable.
        Your strokes are still here. Fix the folder permissions and
        press Retry, or copy the sketch out. (ref: op 4f2a…)"
```

### Failure catalogue

| Failure | Detect | Message | Recovery |
|---|---|---|---|
| Vault folder deleted | `ENOENT` on open | "The vault folder moved." | Recent-vault list; browse for it |
| Folder unwritable | `EACCES` on write | "Sketchback can't write to this folder." | Retry after fix; copy-out button |
| DB corrupt | `SQLITE_CORRUPT` | "This vault's index is damaged." | Rebuild from op log (§8) — genuinely possible because ops are the source of truth; else offer a fresh index |
| DB schema too new | `user_version` > current | "This vault was made by a newer version." | Refuse politely; link to download |
| Blob missing on disk | hash lookup miss | "3 attachments are missing from disk." | Re-download from sync; else placeholders with a re-link affordance |
| Out of disk | `ENOSPC` | "Out of space." | Refuse the write, keep it in memory, tell the user exactly how much is needed |
| Sync unreachable | fetch timeout ×3 | "Can't reach your sync server." | Silent background retry; banner only after 3 failures; never block editing |
| Sync conflict | LWW collision | Nothing — conflicts resolve silently | Inspectable in a conflicts panel (stretch) |
| Mic denied | `NotAllowedError` | "Microphone access was denied." | Deep-link to OS settings; offer file attach |
| Mic absent | `NotFoundError` | "No microphone found." | Offer file attach; hide the record button after one failure |
| Photo too large | decode fails | "That image couldn't be read." | Skip that file, continue the batch, report the count at the end |

### The op log earns its keep here

Because every mutation is an op (§8), index corruption is recoverable: drop the derived tables, replay the log. This is the strongest argument for the op log beyond sync and undo, and it is the answer to risk 5 and risk 2 at the same time. It costs nothing extra to keep ops forever — they are already being written.

### Autosave honesty

The status indicator reflects reality, not optimism. It says *saving* when writing, *saved* when the transaction commits, and *unsaved* when there is anything in the pending buffer. It must never say *saved* while a write is in flight, because the one time the user trusts it is the one time the disk is full.

---

## 34. Telemetry, privacy, and the local-first contract

There is no telemetry. This section exists to make that a design commitment rather than an omission.

### The contract

1. **No analytics.** No usage pings, no crash reporting service, no "anonymous" identifiers.
2. **No network calls except to the sync endpoint you configured.** If the app phones home for anything, it is a bug.
3. **Everything is local until you turn sync on.** Sync is opt-in per §28 and the endpoint is empty by default.
4. **Blobs never leave the device unless they are in a synced idea.** A photo in a local-only idea is not uploaded.
5. **Export is total and lossless.** Everything in the app can be written to a folder you control. If the app were shut down tomorrow, nothing is stranded.

### What the server can see

The sync server (§16) sees idea IDs, op payloads, and blob bytes for synced ideas. It cannot see anything about ideas that were never synced, and it does not decrypt anything — the payloads are the same op format the client stores locally, so **the server is a dumb pipe with a database**. This is a deliberate architectural choice: the sync server is not a trust boundary, because there is nothing to trust it with.

### Why this matters for the product

Local-first is a feature people buy a tool for. A note-taking app that phones home is a different category of software, and the market for that category is crowded with better-funded products. The pitch in §1 is only credible if the privacy story is architectural, not a policy page.

---

## 35. Failure drill, week 8

One afternoon, in week 8, deliberately break things. This is a scheduled task because it will not happen otherwise.

| Drill | How | Pass condition |
|---|---|---|
| Kill mid-write | `kill -9` during a sketch stroke session | Reopens clean; last committed strokes present; no partial block |
| Fill the disk | Mount a 50MB tmpfs as the vault | Clear message; in-memory buffer intact; export-out works |
| Rename the vault folder | Move it while running | App notices, says so, and can re-point |
| Corrupt the DB | Truncate `index.db` mid-session | Rebuild prompt; replay from op log recovers ≥99% of content |
| Delete a blob out from under the app | `rm` an image file | Placeholder, no crash, re-link offered |
| Two devices, offline, conflicting | Laptop + desktop edit the same block offline | Both converge; no data loss on non-overlapping fields |
| Very large idea | Generate a 3,000-block idea | Opens in <2s or degrades visibly and honestly |
| Pathological sketch | 5,000 strokes | Still pans; shows the LOD degradation |

Any drill that reveals a crash-with-no-message is a week-8 bug, not a week-12 bug.

---

## Appendix C — Research log

Running notes, kept during weeks 1–12. Kept short on purpose; this is a decision record, not a diary.

| Week | Question | Finding | Decision |
|---|---|---|---|
| 1 | Does `getUserMedia` work in Tauri v2's WKWebView? | Yes on macOS with `NSMicrophoneUsageDescription`; permissions prompt once | Proceed; §22 risk 1 mitigation stands |
| 1 | Does Tauri v2 fail silently on missing scopes? | Confirmed — `fs` returned null, was a missing `capabilities/default.json` entry | Documented in week 1 acceptance |
| 2 | TipTap: one instance per block, or one big doc with atom nodes? | Per-block tested cleaner; big doc fights foreign DOM on canvas nodes | Per-block (§9) |
| 3 | Fold performance at 10,000 ops | ~4ms full fold, ~0.2ms incremental | Op log viable; gate passed |
| 3 | Virtualising per-block editors | Breaks caret on unmount; fixed by preserving selection by `order_key` | Keep, with the caret guard |
| 4 | Rename cascade cost, 2,000 links | Single indexed UPDATE, 11ms | Approach in §13 stands |
| 5 | Pen feel, iPad + Wacom + cheap Huion | Wacom pressure excellent; Huion reports 0.5 constant | Tier-2 device; documented in §31 |
| 5 | perfect-freehand smoothing lag | One-frame smoothing has no visible lag; 3-frame does | One-frame, `smoothInk` pref |
| 6 | 400 photos, 12MP, semaphore 2 | Peak RSS 310MB, no OOM, 38s | Budget met |
| 7 | WebKitGTK `getUserMedia` | Unreliable as predicted | Linux degrades to file attach; not a blocker |
| 8 | Blob GC vs unsynced ops | Found one real bug: GC ignored audio peaks blob | Fixed; §22 risk 5 confirmed worth its entry |
| 9 | Board drag with 200 cards | Fine; the cost was the card *cover* image, not DnD | Cover lazy-loads on intersection |
| 10 | Terra volume persistence | Ephemeral, confirmed | Backup script runs nightly to a second host |
| 11 | Screen reader pass, VoiceOver | Text, boards, backlinks all good; canvas needs the `role="img"` treatment | §32 table updated |

---

## Appendix D — Glossary

| Term | Meaning |
|---|---|
| **Idea** | The top-level unit. Obsidian's "note." The product word. |
| **Block** | One atom inside an idea. Text, sketch, image, audio, file, callout, embed. |
| **Blob** | Bytes on disk, content-addressed by SHA-256, reference-counted. |
| **Op** | One entry in the append-only mutation log. The unit of undo and of sync. |
| **Fold** | Applying a sequence of ops to derive current state. |
| **LWW** | Last-writer-wins conflict resolution, using `(device_id, lamport, field)`. |
| **Lamport clock** | Monotonic logical timestamp, survives wall-clock going backwards. |
| **order_key** | Fractional index string giving stable, collision-free sibling ordering. |
| **Platform** | The interface abstracting DB, fs, mic, and dialogs. Two impls: Tauri, Memory. |
| **Friction log** | `JOURNAL.md` entries recording daily-use annoyances. The anti-bias mechanism. |
| **Cut ladder** | §23. The ordered list of what to drop when behind. No debate. |
| **Kill criterion** | A pre-committed "if X by day Y, cut feature Z" decision, made while calm. |
| **Pixl** | The YSWS program that converts tracked Hackatime hours into pixels and rewards. |

---

## Appendix E — Anti-patterns

Things that will look productive and are not.

| Anti-pattern | Why it fails | Instead |
|---|---|---|
| Building the graph view early | It's the most screenshot-able and least used feature | Week 11, if at all (§23) |
| Making the block registry "plugin-ready" now | No second consumer exists; §2 says plugins are a non-goal | Add the type when the second consumer lands |
| Abstracting storage before the second storage | YAGNI with a migration cost | One storage path until week 4's gate |
| Polishing onboarding before the app works | Onboarding for a broken app teaches people it's broken | Week 12 (§30) |
| Writing the importer early | It's a week-12 task that needs the format frozen | Week 12, after the schema freeze |
| Optimising before measuring | Premature optimisation costs the same hours and skips the target | `performance.mark` in weeks 3/5/8/11 |
| A second board type before the first works | Board consistency across surfaces is already the hard part (§14) | Gallery/timeline are stretch (§24) |
| Test-driving the UI before the logic is pure | Slow tests that fail for the wrong reason | Pure-function tests first (§20) |
| Keeping both op-log and row-update paths "just in case" | Two sources of truth is the bug, not the hedge | §8: pick one at the gate |
| A sync conflict UI | LWW should be invisible; a conflict UI implies unresolved state | Conflicts panel is stretch (§24) |

---

## Appendix F — The one-page version

If you only read one thing before week 1:

**Sketchback is a local-first block editor where a block can be ink, a photo, a voice memo, or a file, and a kanban board is a view over the same link graph.** Twelve weeks, twenty hours a week, solo, shipping to Pixl.

The architecture in one paragraph: a Tauri v2 shell over React and TipTap; SQLite via a `Platform` interface that also has a pure-memory twin so E2E tests run in a browser; every mutation is an op in an append-only log, with idea and block state derived by folding that log; blobs are content-addressed files with reference counting; sync is the same ops over HTTP to a small Fastify server on a Terra box, merged last-writer-wins per field.

The three weeks that matter are **3** (the op-log decision gate), **5** (sketches, the wedge), and **10** (sync, the kill criterion). The cut ladder in §23 is the permission to stop. The risk register in §22 has a trigger column — when a trigger fires, act on it the same day, do not relitigate.

Pen in hand from week 1. Dogfood the real vault from day one. If the drawing doesn't feel like paper, nothing else matters.
