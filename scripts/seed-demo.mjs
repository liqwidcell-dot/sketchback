/**
 * Fills the app with a demo notebook.
 *
 * Why this exists: a screenshot of an empty app is a screenshot of nothing
 * working. The vault this machine develops against accumulated whatever the
 * previous sessions were poking at — a note called "TEST MAIN" holding fourteen
 * mostly-blank paragraphs — which reads as a broken app rather than an early
 * one. This writes a believable notebook instead.
 *
 * It writes straight to the SQLite file the app opens, using `node:sqlite`, so
 * it needs no running app and no Rust side. Two properties matter:
 *
 *   - The demo text is authored as **markdown** and parsed through the app's
 *     own `MarkdownManager` (the same extension set `BLOCK_EXTENSIONS` uses).
 *     So the ProseMirror JSON in `data_json` is produced by the very schema the
 *     editor loads it back with — no hand-written node trees to drift out of
 *     sync with `@tiptap/starter-kit`.
 *   - Every row it writes is id-prefixed `seed-`, so it can always find and
 *     replace exactly its own data and never touch anything else. Re-running is
 *     idempotent.
 *
 *   npm run seed            add/replace the demo ideas
 *   npm run seed -- --fresh first hide every non-demo idea (reversible)
 *   npm run seed -- --list  show what is in the vault and exit
 *   npm run seed -- --dry-run  say what would change, write nothing
 *
 * The app caches its idea list in memory, so reload it (Ctrl+R) — or restart it
 * — to see the result. Search is week 4 and its FTS table is not populated here.
 */
import { existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { generateKeyBetween } from "fractional-indexing";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

/* ────────────────────────────────── args ─────────────────────────────────── */

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

if (has("--help") || has("-h")) {
  console.log(
    [
      "Seed the Sketchback vault with a demo notebook.",
      "",
      "  npm run seed                 add or replace the demo ideas",
      "  npm run seed -- --fresh      also hide every non-demo idea (reversible)",
      "  npm run seed -- --list       show the vault and exit",
      "  npm run seed -- --check      print the stored demo text as markdown",
      "  npm run seed -- --dry-run    report what would change, write nothing",
      "  npm run seed -- --db <path>  use a specific database file",
      "",
      "Demo rows all have ids starting with `seed-`, so this only ever replaces",
      "its own data. Re-running is safe and idempotent.",
    ].join("\n"),
  );
  process.exit(0);
}

/**
 * Where the app keeps its database. `tauri-plugin-sql` resolves paths against
 * `BaseDirectory::AppConfig`, which is per-OS — see the deviation noted in the
 * journal. Getting this wrong on Windows means writing to a directory the app
 * never reads, so the three cases are spelled out.
 */
function defaultDbPath() {
  const bundleId = "com.sketchback.app";
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, bundleId, "sketchback.db");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", bundleId, "sketchback.db");
  }
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, bundleId, "sketchback.db");
}

const dbPath = valueOf("--db", defaultDbPath());
if (!existsSync(dbPath)) {
  console.error(
    `seed: no database at ${dbPath}\n` +
      "Run the app once so it creates its schema, or pass --db <path>.",
  );
  process.exit(1);
}

/* ──────────────────────────────── the corpus ─────────────────────────────── */

/**
 * Each block is markdown. It is parsed to a ProseMirror doc and stored, which
 * is exactly what the app does with text it imports — see plan §17 and the
 * "markdown goes in and out, never stored" note in §2.
 */
const IDEAS = [
  {
    slug: "sketchback",
    title: "Sketchback",
    pinned: true,
    ageMinutes: 0,
    blocks: [
      "## What it is",
      "Obsidian-shaped, but the atom isn't a paragraph — it's a **block**. A block can be ink, a photo, a voice memo, or a file.",
      "Project boards are a view over the link graph, not a separate thing.",
      [
        "- **Sketch layer.** An infinite canvas as just another block.",
        "- **Media.** Drop 400 phone photos into an idea and the app keeps up.",
        "- **Boards.** A kanban whose cards *are* your ideas.",
      ].join("\n"),
      "## One rule",
      "Everything is a blob or a block. A sketch is a block. A photo is a block plus blobs. Nothing gets a bespoke way of being saved.",
      "## Decisions worth remembering",
      [
        "- `order_key` is a base-62 fraction, so inserting never renumbers a sibling.",
        "- A block stores ProseMirror JSON, not markdown.",
        "- Markdown is an import and export format, never the storage format.",
      ].join("\n"),
      "> A kanban whose cards _are_ your ideas. Drag a card and the idea moves.",
      "---",
      "Still to do this week: drag-to-reorder, then split and merge. See the [build plan](https://github.com/liqwidcell-dot/sketchback/blob/main/plan-final.md).",
    ],
  },
  {
    slug: "reading",
    title: "Reading list",
    ageMinutes: 90,
    blocks: [
      "## Queue",
      [
        "- [The Humane Interface](https://en.wikipedia.org/wiki/The_Humane_Interface) — Raskin, on modes and why they hurt.",
        "- [A Pattern Language](https://en.wikipedia.org/wiki/A_Pattern_Language) — read the entries as a design vocabulary, skim the rest.",
        "- *Thinking in Systems* — borrowed, needs returning.",
      ].join("\n"),
      "## Notes as I go",
      "Raskin's point about **quasimodes** — holding a key to change meaning — is why the command palette works better than a toolbar. The mode only exists while your finger is down.",
      "---",
      "Zettelkasten keeps coming up. The interesting part isn't the slip-box, it's that writing the link *forces* the comparison.",
    ],
  },
  {
    slug: "kyoto",
    title: "Kyoto, April",
    ageMinutes: 60 * 5,
    blocks: [
      "## Rough shape",
      [
        "- **Apr 2–5** — arrive, stay near Kyoto Station, get over the flight.",
        "- **Apr 6–9** — Higashiyama. Walk the Philosopher's Path early, before the crowds.",
        "- **Apr 10–12** — Arashiyama, then a day trip to Nara.",
        "- **Apr 13** — back to Tokyo, fly home on the 14th.",
      ].join("\n"),
      "## Booking",
      [
        "1. Flights first — prices move fastest.",
        "2. Then the first hotel; everything else can wait.",
        "3. Rail pass is probably not worth it for this route. Do the arithmetic before buying.",
      ].join("\n"),
      "> Cherry blossom dates are a guess. Book refundable, or accept missing the peak and go anyway.",
      "Packing note: one bag, and the good walking shoes. The paths are longer than they look on a map.",
    ],
  },
  {
    slug: "sourdough",
    title: "Sourdough — week 3",
    ageMinutes: 60 * 26,
    blocks: [
      "## Starter",
      "Doubled in about **5 hours** at 24°C, which is roughly where I want it. Still a little sharp — try feeding twice a day for a few days and see if it rounds out.",
      "## This week's bake",
      [
        "1. 500 g flour, 350 g water, rest 45 min.",
        "2. Add 100 g starter and 10 g salt.",
        "3. Fold every 30 min, four times.",
        "4. Bulk until it jiggles, then shape and cold-proof overnight.",
      ].join("\n"),
      "> 78% hydration was too wet to shape. 70% next time, same flour.",
      "Crumb was tight at the bottom and open at the top, so the shaping is still the weak link — not the proof.",
      "---",
      "Buy a second banneton. One is not enough when two loaves are going.",
    ],
  },
  {
    slug: "bike-light",
    title: "Bike light teardown",
    ageMinutes: 60 * 50,
    blocks: [
      "## Why it keeps dying",
      "It does not hold charge for more than a day, and the switch feels mushy. Suspect a tired cell, not the driver board.",
      "## Teardown order",
      [
        "1. Undo the two Torx screws under the lens ring.",
        "2. Prise the housing — start at the USB end, there is a clip there.",
        "3. Note the connector before pulling. It is keyed but the key is subtle.",
      ].join("\n"),
      "## What is inside",
      [
        "- One 18650-ish cell, spot-welded, no holder — awkward to swap.",
        "- A tiny charging board with a **TP4056**-shaped footprint.",
        "- The whole lens assembly is a single moulded part.",
      ].join("\n"),
      "```\ncharge board silkscreen:\n  +  -  B  B  OUT+  OUT-\n  TP4056  ·  2 LEDs, one red one blue\n```",
      "Verdict: worth repairing, the cell is standard. Order two and keep one as a spare — they are pennies.",
    ],
  },
  {
    slug: "weekly",
    title: "Weekly review — Oct 12",
    ageMinutes: 60 * 74,
    blocks: [
      "## Landed",
      [
        "- Base text block, with markdown in and out.",
        "- The folder export, and it round-trips.",
        "- Right-click is the app's own menu now, not the webview's.",
      ].join("\n"),
      "## Dragged",
      "Export took longer than it should have. The escaped-wikilink problem — the serializer escaping `[[` into `\\[\\[` — cost most of an afternoon and the answer was one regex that matches the *escaped* form.",
      "## Next",
      [
        "- Drag to reorder, and the mid-block split.",
        "- Then the acceptance test: 400 words, reorder ten blocks, undo, reopen.",
      ].join("\n"),
      "> The test that matters is reopening the app. Everything passes while it is still open.",
    ],
  },
];

/* ────────────────────────────── markdown → doc ───────────────────────────── */

/** The app's own pipeline: `BLOCK_EXTENSIONS` minus the editor-only placeholder. */
const markdown = new MarkdownManager({ extensions: [StarterKit, Markdown] });

/**
 * Parse one block's markdown, refusing to store anything the schema did not
 * produce. A silent failure here would put a document the editor cannot load
 * into the vault, which is precisely the class of bug the seed exists to avoid.
 */
function toDoc(source, where) {
  let doc;
  try {
    doc = markdown.parse(source);
  } catch (err) {
    throw new Error(`seed: could not parse ${where}: ${err.message}\n---\n${source}`);
  }
  if (!doc || doc.type !== "doc") {
    throw new Error(`seed: ${where} parsed to ${JSON.stringify(doc)?.slice(0, 60)}`);
  }

  // Two authoring slips that parse happily into the *wrong* thing, both of which
  // this corpus has already produced once: a fenced block written as separate
  // array entries (so each line became its own block), and a bullet line written
  // without its marker (so it collapsed into a paragraph). Neither is visible in
  // the JSON, so assert the shape the markdown plainly asks for.
  const types = new Set();
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.type) types.add(node.type);
    for (const child of node.content ?? []) walk(child);
  })(doc);

  if (/^\s*([-*+]|\d+\.)\s/.test(source) && !types.has("bulletList") && !types.has("orderedList")) {
    throw new Error(`seed: ${where} opens with a list marker but parsed to [${[...types]}]`);
  }
  if (source.includes("```") && !types.has("codeBlock")) {
    throw new Error(`seed: ${where} contains a fence but parsed to [${[...types]}]`);
  }

  return JSON.stringify(doc);
}

/* ─────────────────────────────────── main ────────────────────────────────── */

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

// Fail loudly rather than creating half a vault if the app has not been run.
for (const table of ["idea", "block"]) {
  const found = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!found) {
    console.error(`seed: ${dbPath} has no ${table} table — run the app once first.`);
    process.exit(1);
  }
}

const SEED_LIKE = "seed-%";

function report() {
  const ideas = db
    .prepare(
      `SELECT i.id, i.title, i.pinned,
              (SELECT COUNT(*) FROM block b
                WHERE b.idea_id = i.id AND b.deleted_at IS NULL) AS blocks
         FROM idea i
        WHERE i.deleted_at IS NULL
        ORDER BY i.pinned DESC, i.updated_at DESC`,
    )
    .all();
  const hidden = db
    .prepare("SELECT COUNT(*) AS n FROM idea WHERE deleted_at IS NOT NULL")
    .get().n;
  console.log(`\n${dbPath}\n`);
  for (const row of ideas) {
    const tag = row.id.startsWith("seed-") ? "seed" : "  ──";
    console.log(
      `  ${tag}  ${row.pinned ? "★" : " "}  ${String(row.blocks).padStart(2)} blocks  ${row.title}`,
    );
  }
  if (!ideas.length) console.log("  (no visible ideas)");
  if (hidden) console.log(`\n  ${hidden} hidden (soft-deleted)`);
}

if (has("--list")) {
  report();
  db.close();
  process.exit(0);
}

/**
 * Print the stored corpus back out as markdown. The demo text is authored as
 * markdown and stored as ProseMirror JSON, so reading it the other way round is
 * how you check the round trip — a bullet written without its `-` collapses
 * into a paragraph with line breaks, and this is where that shows up.
 */
if (has("--check")) {
  const rows = db
    .prepare(
      `SELECT i.title, b.data_json
         FROM block b JOIN idea i ON i.id = b.idea_id
        WHERE b.idea_id LIKE ? AND b.deleted_at IS NULL
        ORDER BY i.pinned DESC, i.updated_at DESC, b.order_key`,
    )
    .all(SEED_LIKE);
  let title = null;
  for (const row of rows) {
    if (row.title !== title) {
      title = row.title;
      console.log(`\n${"─".repeat(64)}\n${title}\n`);
    }
    console.log(markdown.serialize(JSON.parse(row.data_json)));
  }
  db.close();
  process.exit(0);
}

const fresh = has("--fresh");
const dryRun = has("--dry-run");

// ── soft-delete everything that is not ours, when asked ──────────────────────
const strays = db
  .prepare(
    `SELECT id, title FROM idea
      WHERE deleted_at IS NULL AND id NOT LIKE ?`,
  )
  .all(SEED_LIKE);

if (fresh && strays.length) {
  console.log(`--fresh: hiding ${strays.length} non-demo idea(s) — reversible:`);
  for (const s of strays) console.log(`    ${s.title || "(untitled)"}  ${s.id}`);
  console.log(`    to undo:  UPDATE idea SET deleted_at = NULL WHERE id IN (…);`);
}

// ── build the rows ──────────────────────────────────────────────────────────
const base = Date.now();
/** Newest first in the sidebar (`ORDER BY pinned DESC, updated_at DESC`). */
const stamp = (ageMinutes) => base - Math.round(ageMinutes * 60_000);

const ideas = IDEAS.map((idea) => {
  const at = stamp(idea.ageMinutes);
  const blocks = [];
  let prev = null;
  idea.blocks.forEach((source, n) => {
    const orderKey = generateKeyBetween(prev, null);
    prev = orderKey;
    blocks.push({
      id: `seed-${idea.slug}-${String(n + 1).padStart(2, "0")}`,
      type: "text",
      order_key: orderKey,
      // Stagger within the idea so created_at is not all one instant.
      data_json: toDoc(source, `${idea.title} block ${n + 1}`),
      created_at: at + n,
      updated_at: at + n,
    });
  });
  return { id: `seed-${idea.slug}`, title: idea.title, pinned: idea.pinned ? 1 : 0, at, blocks };
});

console.log(
  `seed: ${ideas.length} ideas, ${ideas.reduce((n, i) => n + i.blocks.length, 0)} blocks` +
    ` (${dryRun ? "dry run" : dbPath})`,
);

if (dryRun) {
  for (const idea of ideas) console.log(`    ${idea.title} — ${idea.blocks.length} blocks`);
  db.close();
  process.exit(0);
}

// A copy before the first write, because this is someone's real vault. Kept
// beside the database rather than in the repo, and only if one is not there yet.
const backup = `${dbPath}.pre-seed.bak`;
if (!existsSync(backup)) {
  copyFileSync(dbPath, backup);
  console.log(`seed: backed up to ${backup}`);
}

db.exec("BEGIN");
try {
  if (fresh && strays.length) {
    const hide = db.prepare("UPDATE idea SET deleted_at = ? WHERE id = ?");
    for (const s of strays) hide.run(base, s.id);
  }

  // Replace our own rows wholesale: simplest way to stay idempotent, and the
  // cascade clears their blocks.
  db.prepare("DELETE FROM idea WHERE id LIKE ?").run(SEED_LIKE);

  const insertIdea = db.prepare(
    "INSERT INTO idea (id, title, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  const insertBlock = db.prepare(
    `INSERT INTO block (id, idea_id, type, order_key, data_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const idea of ideas) {
    insertIdea.run(idea.id, idea.title, idea.pinned, idea.at, idea.at);
    for (const b of idea.blocks) {
      insertBlock.run(
        b.id,
        idea.id,
        b.type,
        b.order_key,
        b.data_json,
        b.created_at,
        b.updated_at,
      );
    }
  }
  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  throw err;
}

report();
db.close();
console.log(
  "\nReload the app (Ctrl+R) to see it — it caches the idea list in memory.\n" +
    "To screenshot the editor, click an idea: the router needs #/idea/<id>.\n",
);
