/**
 * Sketchback — the whole frontend.
 *
 * Deliberately one file. The plan's `platform/`, `db/`, `views/`, `components/`
 * split is collapsed until it earns its keep. What lives here:
 *   - the Platform interface + its two implementations (plan §4)
 *   - the SQL query table (plan §7's schema, queried)
 *   - the Zustand store and the boot sequence
 *   - the three views: Sidebar, IdeaView, CommandPalette
 *   - a 20-line hash router
 */
import { createRoot } from "react-dom/client";
import { create } from "zustand";
import Database from "@tauri-apps/plugin-sql";
import { appConfigDir } from "@tauri-apps/api/path";
import { getVersion } from "@tauri-apps/api/app";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { Placeholder } from "@tiptap/extension-placeholder";
import { isAtEndOfNode, type JSONContent } from "@tiptap/core";
import { generateKeyBetween } from "fractional-indexing";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import "./styles.css";

/* ─────────────────────────── Platform (plan §4) ─────────────────────────── */

export interface PickedFile {
  name: string;
  mime: string;
  data: Uint8Array;
}

export interface MicSession {
  stop(): Promise<Blob>;
}

/**
 * Every host capability goes through this one interface. Two implementations:
 * `TauriPlatform` (real) and `MemoryPlatform` (the Vitest seam). Week 1 wires
 * `db` and `app`; the rest are stubs that fail loudly instead of silently
 * returning nothing — a silent `fs` failure is the trap the plan calls out.
 */
export interface Platform {
  db: {
    all<T>(sql: string, params?: unknown[]): Promise<T[]>;
    run(sql: string, params?: unknown[]): Promise<void>;
  };
  fs: {
    readBlob(hash: string): Promise<Uint8Array>;
    writeBlob(data: Uint8Array, mime: string): Promise<string>;
    blobPath(hash: string): Promise<string>;
    statBlob(hash: string): Promise<{ size: number } | null>;
    deleteBlob(hash: string): Promise<void>;
  };
  hash: { sha256(data: Uint8Array): Promise<string> };
  dialog: {
    pickFiles(): Promise<PickedFile[]>;
    saveFile(name: string, data: Uint8Array): Promise<string | null>;
  };
  mic: {
    isAvailable(): Promise<boolean>;
    start(): Promise<MicSession>;
    stop(): Promise<Blob>;
  };
  app: { vaultRoot(): Promise<string>; version(): Promise<string> };
}

function notYet<T>(what: string): () => Promise<T> {
  return async () => {
    throw new Error(`${what} is not wired up yet (arrives week 5–7).`);
  };
}

const stubFs = (): Platform["fs"] => ({
  readBlob: notYet("fs.readBlob"),
  writeBlob: notYet("fs.writeBlob"),
  blobPath: notYet("fs.blobPath"),
  statBlob: notYet("fs.statBlob"),
  deleteBlob: notYet("fs.deleteBlob"),
});

const stubDialog = (): Platform["dialog"] => ({
  pickFiles: notYet("dialog.pickFiles"),
  saveFile: notYet("dialog.saveFile"),
});

const stubMic = (): Platform["mic"] => ({
  isAvailable: notYet("mic.isAvailable"),
  start: notYet("mic.start"),
  stop: notYet("mic.stop"),
});

export function TauriPlatform(): Platform {
  let handle: Database | null = null;
  const conn = async (): Promise<Database> =>
    (handle ??= await Database.load("sqlite:sketchback.db"));

  return {
    db: {
      async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        return (await (await conn()).select(sql, params)) as T[];
      },
      async run(sql: string, params: unknown[] = []): Promise<void> {
        await (await conn()).execute(sql, params);
      },
    },
    fs: stubFs(),
    hash: { sha256: notYet("hash.sha256") },
    dialog: stubDialog(),
    mic: stubMic(),
    app: {
      vaultRoot: () => appConfigDir(),
      version: () => getVersion(),
    },
  };
}

/**
 * In-memory Maps, for Vitest in a plain Node process — no webview, no Rust.
 * The row store lands with the test harness in week 3; until then this is the
 * seam and nothing more.
 */
export function MemoryPlatform(): Platform {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  void tables; // week 3 fills this in
  return {
    db: { all: notYet("MemoryPlatform.db.all"), run: notYet("MemoryPlatform.db.run") },
    fs: stubFs(),
    hash: { sha256: notYet("hash.sha256") },
    dialog: stubDialog(),
    mic: stubMic(),
    app: {
      vaultRoot: async () => "memory://vault",
      version: async () => "0.0.0-memory",
    },
  };
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const platform: Platform = isTauri ? TauriPlatform() : MemoryPlatform();

/* ───────────────────────────── SQL (plan §7) ─────────────────────────────── */

export interface IdeaRow {
  id: string;
  title: string;
  icon: string | null;
  pinned: number;
  created_at: number;
  updated_at: number;
}

/** A row from `block` (plan §7). `data_json` is opaque per block type. */
export interface BlockRow {
  id: string;
  idea_id: string;
  type: string;
  order_key: string;
  data_json: string;
  created_at: number;
  updated_at: number;
}

/**
 * A `text` block's `data_json` is a ProseMirror document, not markdown: plan §2
 * rules markdown out as a storage format (it cannot round-trip ink, and a
 * paragraph is only one of several block types). Markdown still goes in and out
 * — see `TEXT_BLOCK` and the Markdown extension below.
 */
const EMPTY_DOC = JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] });

const SQL = {
  seedVault: `INSERT OR IGNORE INTO vault (id, name, created_at) VALUES ('local', $1, $2)`,
  seedDevice: `INSERT OR IGNORE INTO device (id, name, created_at) VALUES ($1, $2, $3)`,
  listIdeas: `SELECT id, title, icon, pinned, created_at, updated_at
                FROM idea WHERE deleted_at IS NULL
               ORDER BY pinned DESC, updated_at DESC`,
  insertIdea: `INSERT INTO idea (id, title, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
  renameIdea: `UPDATE idea SET title = $1, updated_at = $2 WHERE id = $3`,
  softDeleteIdea: `UPDATE idea SET deleted_at = $1, updated_at = $1 WHERE id = $2`,
  touchIdea: `UPDATE idea SET updated_at = $1 WHERE id = $2`,
  listBlocks: `SELECT id, idea_id, type, order_key, data_json, created_at, updated_at
                 FROM block WHERE idea_id = $1 AND deleted_at IS NULL
                ORDER BY order_key`,
  insertBlock: `INSERT INTO block (id, idea_id, type, order_key, data_json, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $6)`,
  updateBlockData: `UPDATE block SET data_json = $1, updated_at = $2 WHERE id = $3`,
  softDeleteBlock: `UPDATE block SET deleted_at = $1, updated_at = $1 WHERE id = $2`,
  readPrefs: `SELECT key, value FROM prefs`,
  writePref: `INSERT INTO prefs (key, value, updated_at) VALUES ($1, $2, $3)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
} as const;

const now = () => Date.now();

/* ──────────────────────────── Theme (plan §27–28) ───────────────────────── */

export type ThemeMode = "light" | "dark" | "system";

/** `null` accent means "whatever the theme's default is" (plan §28). */
const THEME_ACCENT: Record<"light" | "dark", string> = {
  light: "#3b6ea5",
  dark: "#7aa8d8",
};

function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Accepts `abc`, `#abc`, `aabbcc`, `#aabbcc`; returns `#aabbcc` or null. */
function normalizeHex(input: string): string | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!match) return null;
  const body = match[1].toLowerCase();
  const full = body.length === 3 ? body.replace(/./g, (c) => c + c) : body;
  return `#${full}`;
}

/**
 * Read a stored block back into a ProseMirror doc, falling back to an empty one
 * rather than letting a malformed row take the editor down.
 */
function parseDoc(dataJson: string): JSONContent {
  try {
    const parsed: unknown = JSON.parse(dataJson);
    if (parsed && typeof parsed === "object" && (parsed as JSONContent).type === "doc") {
      return parsed as JSONContent;
    }
  } catch {
    // Fall through to the empty document.
  }
  return JSON.parse(EMPTY_DOC) as JSONContent;
}

/* ─────────────────────────── Context menu ───────────────────────────────── */

/**
 * One right-click menu, shared by every surface that needs one. Plan §9 gives
 * blocks their own later; "Move to group…" is then a single entry here, which is
 * why items are plain data rather than bespoke markup.
 */
export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Destructive actions render in the danger colour. */
  danger?: boolean;
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/* ─────────────────────────────── Store ──────────────────────────────────── */

interface State {
  ready: boolean;
  error: string | null;
  ideas: IdeaRow[];
  vaultRoot: string;
  version: string;
  paletteOpen: boolean;
  theme: ThemeMode;
  accent: string | null;
  themeOpen: boolean;
  menu: MenuState | null;
  pendingDelete: IdeaRow | null;
  blocks: BlockRow[];
  /** Which idea `blocks` belongs to; guards against a stale async load. */
  blocksFor: string | null;
  blocksLoaded: boolean;
  /** Set after creating a block so the new editor can claim the caret. */
  focusBlockId: string | null;
  setPalette(open: boolean): void;
  setThemeOpen(open: boolean): void;
  setTheme(mode: ThemeMode): Promise<void>;
  setAccent(hex: string | null): Promise<void>;
  openMenu(x: number, y: number, items: MenuItem[]): void;
  closeMenu(): void;
  askDelete(idea: IdeaRow): void;
  cancelDelete(): void;
  confirmDelete(): Promise<void>;
  clearFocusBlock(): void;
  loadBlocks(ideaId: string): Promise<void>;
  createTextBlock(ideaId: string, afterId?: string | null): Promise<string>;
  saveBlockDoc(id: string, doc: JSONContent): Promise<void>;
  removeBlock(id: string): Promise<void>;
  refresh(): Promise<void>;
  createIdea(title?: string): Promise<string>;
  renameIdea(id: string, title: string): Promise<void>;
  deleteIdea(id: string): Promise<void>;
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  error: null,
  ideas: [],
  vaultRoot: "",
  version: "",
  paletteOpen: false,
  theme: "system",
  accent: null,
  themeOpen: false,
  menu: null,
  pendingDelete: null,
  blocks: [],
  blocksFor: null,
  blocksLoaded: false,
  focusBlockId: null,

  setPalette: (open) => set({ paletteOpen: open }),
  setThemeOpen: (open) => set({ themeOpen: open }),
  openMenu: (x, y, items) => set({ menu: { x, y, items } }),
  closeMenu: () => set({ menu: null }),

  // Deleting is confirmed, not instant (plan §28: `confirmDelete` defaults to
  // true). The confirm lives here so the sidebar and the idea view share it.
  askDelete: (idea) => set({ pendingDelete: idea }),
  cancelDelete: () => set({ pendingDelete: null }),

  async confirmDelete() {
    const idea = get().pendingDelete;
    if (!idea) return;
    set({ pendingDelete: null });
    await get().deleteIdea(idea.id);
  },

  async setTheme(mode) {
    set({ theme: mode });
    await platform.db.run(SQL.writePref, ["theme", JSON.stringify(mode), now()]);
  },

  async setAccent(hex) {
    set({ accent: hex });
    await platform.db.run(SQL.writePref, ["accent", JSON.stringify(hex), now()]);
  },

  clearFocusBlock: () => set({ focusBlockId: null }),

  async loadBlocks(ideaId) {
    // Claim the request immediately so a slow response for a previous idea
    // can't overwrite the current one (see the guard below).
    set({ blocksFor: ideaId, blocks: [], blocksLoaded: false });
    const rows = await platform.db.all<BlockRow>(SQL.listBlocks, [ideaId]);
    if (get().blocksFor !== ideaId) return;
    set({ blocks: rows, blocksLoaded: true });
  },

  /**
   * Insert a `text` block after `afterId` (or at the end when omitted). The
   * order key is generated between its neighbours, so inserting never renumbers
   * a sibling (plan §9).
   */
  async createTextBlock(ideaId, afterId = null) {
    const blocks = get().blocks;
    const at = afterId ? blocks.findIndex((b) => b.id === afterId) : -1;
    let lower: string | null;
    let upper: string | null = null;
    if (at >= 0) {
      lower = blocks[at].order_key;
      upper = blocks[at + 1]?.order_key ?? null;
    } else {
      lower = blocks.length ? blocks[blocks.length - 1].order_key : null;
    }

    const ts = now();
    const block: BlockRow = {
      id: crypto.randomUUID(),
      idea_id: ideaId,
      type: "text",
      order_key: generateKeyBetween(lower, upper),
      data_json: EMPTY_DOC,
      created_at: ts,
      updated_at: ts,
    };

    // Claim the slot in state *before* awaiting the insert. Two quick Enters
    // would otherwise both read the same neighbours and mint the same key, and
    // a duplicate order_key makes ordering unstable.
    const next = [...blocks];
    next.splice(at >= 0 ? at + 1 : next.length, 0, block);
    set({ blocks: next });

    try {
      await platform.db.run(SQL.insertBlock, [
        block.id,
        block.idea_id,
        block.type,
        block.order_key,
        block.data_json,
        ts,
      ]);
    } catch (err) {
      set({ blocks: get().blocks.filter((b) => b.id !== block.id) });
      throw err;
    }
    return block.id;
  },

  // Deliberately does not touch the store: the editor is the live source for
  // its own content, so re-setting `blocks` here would re-render every block on
  // each keystroke for no gain.
  async saveBlockDoc(id, doc) {
    const ts = now();
    await platform.db.run(SQL.updateBlockData, [JSON.stringify(doc), ts, id]);
    const ideaId = get().blocks.find((b) => b.id === id)?.idea_id;
    if (ideaId) await platform.db.run(SQL.touchIdea, [ts, ideaId]);
  },

  async removeBlock(id) {
    const previous = get().blocks;
    set({ blocks: previous.filter((b) => b.id !== id) });
    try {
      await platform.db.run(SQL.softDeleteBlock, [now(), id]);
    } catch (err) {
      set({ blocks: previous });
      throw err;
    }
  },

  async refresh() {
    set({ ideas: await platform.db.all<IdeaRow>(SQL.listIdeas) });
  },

  async createIdea(title = "Untitled") {
    const id = crypto.randomUUID();
    await platform.db.run(SQL.insertIdea, [id, title, now()]);
    await get().refresh();
    return id;
  },

  async renameIdea(id, title) {
    const clean = title.trim() || "Untitled";
    await platform.db.run(SQL.renameIdea, [clean, now(), id]);
    await get().refresh();
  },

  async deleteIdea(id) {
    await platform.db.run(SQL.softDeleteIdea, [now(), id]);
    await get().refresh();
  },
}));

async function boot(): Promise<void> {
  try {
    const [vaultRoot, version] = await Promise.all([
      platform.app.vaultRoot(),
      platform.app.version(),
    ]);

    // Best-effort connection setup. WAL cannot be set inside a transaction, so
    // this is deliberately outside the migration.
    for (const pragma of [
      "PRAGMA journal_mode = WAL",
      "PRAGMA foreign_keys = ON",
      "PRAGMA busy_timeout = 5000",
    ]) {
      await platform.db.run(pragma).catch(() => {});
    }

    await platform.db.run(SQL.seedVault, ["My Vault", now()]);

    let deviceId = localStorage.getItem("sketchback.device_id");
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem("sketchback.device_id", deviceId);
    }
    await platform.db.run(SQL.seedDevice, [deviceId, "This device", now()]);

    // Search is week 4. Create the FTS5 table now, but degrade if the driver
    // was built without it rather than failing the whole boot.
    await platform.db
      .run(
        `CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
           idea_id UNINDEXED, title, body,
           tokenize = 'porter unicode61 remove_diacritics 2')`,
      )
      .catch((e) => console.warn("FTS5 unavailable; search disabled:", e));

    // Preferences (plan §28). Values are JSON-encoded scalars.
    let theme: ThemeMode = "system";
    let accent: string | null = null;
    for (const row of await platform.db.all<{ key: string; value: string }>(SQL.readPrefs)) {
      try {
        if (row.key === "theme") theme = JSON.parse(row.value) as ThemeMode;
        else if (row.key === "accent") accent = JSON.parse(row.value) as string | null;
      } catch {
        // A malformed row should never block boot; fall back to the default.
      }
    }

    await useStore.getState().refresh();
    useStore.setState({ ready: true, vaultRoot, version, theme, accent });
  } catch (e) {
    useStore.setState({ ready: true, error: e instanceof Error ? e.message : String(e) });
  }
}

/* ─────────────────────────────── Router ─────────────────────────────────── */

function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const onHash = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const match = /^#\/idea\/(.+)$/.exec(hash);
  const navigate = useCallback((next: string) => {
    window.location.hash = next;
  }, []);
  return { ideaId: match ? decodeURIComponent(match[1]) : null, navigate };
}

/* ─────────────────────────────── Views ──────────────────────────────────── */

function Splash() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-text-secondary">
      Opening vault…
    </div>
  );
}

function BootError({ error }: { error: string }) {
  return (
    <div className="flex h-full flex-col items-start gap-3 p-8">
      <h1 className="text-xl">Sketchback could not open its vault.</h1>
      <p className="text-sm text-text-secondary">
        This is a desktop app; the database is only reachable inside the Tauri shell.
        Run it with <code className="font-mono text-text-primary">npm run tauri dev</code>.
      </p>
      <pre className="max-w-full overflow-x-auto rounded border border-border-subtle bg-surface-sunken p-3 font-mono text-xs text-danger">
        {error}
      </pre>
    </div>
  );
}

function Sidebar({
  activeId,
  onOpen,
  onNew,
}: {
  activeId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const ideas = useStore((s) => s.ideas);
  const vaultRoot = useStore((s) => s.vaultRoot);
  const version = useStore((s) => s.version);
  const setThemeOpen = useStore((s) => s.setThemeOpen);
  const openMenu = useStore((s) => s.openMenu);
  const renameIdea = useStore((s) => s.renameIdea);
  const askDelete = useStore((s) => s.askDelete);

  // Inline rename. The flag survives Escape, because unmounting a focused input
  // can still fire a blur — without it, cancelling would commit the draft.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const startRename = (id: string) => {
    cancelledRef.current = false;
    setRenamingId(id);
  };

  const commitRename = (id: string, value: string) => {
    const cancelled = cancelledRef.current;
    cancelledRef.current = false;
    setRenamingId(null);
    if (!cancelled) void renameIdea(id, value);
  };

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border-subtle bg-surface-sunken">
      <header className="flex items-center gap-2 px-3 py-3">
        <span className="flex items-center gap-1.5 text-sm font-semibold tracking-wide">
          <span aria-hidden className="size-1.5 rounded-full bg-accent" />
          Sketchback
        </span>
        <button
          type="button"
          onClick={onNew}
          title="New idea"
          className="ml-auto rounded border border-accent/40 bg-surface-raised px-2 py-0.5 text-xs text-accent transition-colors duration-[120ms] ease-standard hover:border-accent hover:bg-accent hover:text-on-accent"
        >
          +
        </button>
      </header>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {ideas.length === 0 ? (
          <p className="px-2 py-6 text-xs text-text-secondary">No ideas yet. Make one.</p>
        ) : (
          <ul>
            {ideas.map((idea) => {
              const active = idea.id === activeId;
              return (
                <li key={idea.id}>
                  {renamingId === idea.id ? (
                    <input
                      autoFocus
                      defaultValue={idea.title}
                      onFocus={(e) => e.currentTarget.select()}
                      onBlur={(e) => commitRename(idea.id, e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          e.currentTarget.blur();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelledRef.current = true;
                          setRenamingId(null);
                        }
                      }}
                      aria-label="Rename idea"
                      spellCheck={false}
                      className="w-full rounded border border-accent bg-surface-raised px-2 py-0.5 text-sm text-text-primary outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => onOpen(idea.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        openMenu(e.clientX, e.clientY, [
                          { label: "Open", onSelect: () => onOpen(idea.id) },
                          { label: "Rename", onSelect: () => startRename(idea.id) },
                          {
                            label: "Delete",
                            danger: true,
                            onSelect: () => askDelete(idea),
                          },
                        ]);
                      }}
                      aria-current={active ? "page" : undefined}
                      className={[
                        "relative flex w-full items-center gap-2 rounded py-1 pr-2 pl-3 text-left text-sm",
                        "transition-colors duration-[120ms] ease-standard",
                        active
                          ? "bg-surface-raised text-text-primary shadow-[0_4px_12px_rgb(0_0_0/0.08)]"
                          : "text-text-secondary hover:bg-surface-raised hover:text-text-primary",
                      ].join(" ")}
                    >
                      {active && (
                        <span
                          aria-hidden
                          className="absolute top-1 bottom-1 left-1 w-0.5 rounded-full bg-accent"
                        />
                      )}
                      <span className={active ? "text-accent" : undefined}>
                        {idea.icon ?? "◇"}
                      </span>
                      <span className="truncate">{idea.title}</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      <footer className="border-t border-border-subtle px-3 py-2 text-xs text-text-secondary">
        <button
          type="button"
          onClick={() => setThemeOpen(true)}
          className="mb-2 flex w-full items-center gap-2 rounded px-1 py-1 text-left transition-colors duration-[120ms] ease-standard hover:bg-accent/10 hover:text-accent"
        >
          <span aria-hidden className="text-accent">◐</span>
          <span>Theme</span>
        </button>
        <div className="truncate" title={vaultRoot}>
          {vaultRoot || "—"}
        </div>
        <div>v{version || "…"}</div>
      </footer>
    </aside>
  );
}

/**
 * Extensions shared by every block. Hoisted so the instances keep their
 * identity across renders — `useEditor` diffs options by reference, and
 * rebuilding `Placeholder.configure(...)` each render is pure waste.
 */
const BLOCK_EXTENSIONS = [
  StarterKit,
  Markdown,
  // Every block is its own editor, so the hint is CSS-gated to the focused
  // block (see styles.css) rather than shouted by every empty one.
  Placeholder.configure({ placeholder: "Write something, or try # for a heading" }),
];

/**
 * One `text` block. Per plan §9 each block owns its own TipTap instance, which
 * is the seam that later lets sketches and audio be atoms in a normal document
 * rather than the editor fighting foreign DOM.
 *
 * Storage is ProseMirror JSON (plan §2 rules markdown out as a *storage*
 * format). Markdown is still first class: StarterKit supplies the §9 shortcut
 * set (`#`, `-`, `1.`, `>`, fences, `---`, `**`, `*`, `` ` ``, `~~`), the
 * Markdown extension supplies an unescape-safe serializer, and "Copy as
 * Markdown" on the block menu hands the whole block out as markdown.
 */
function TextBlock({ block }: { block: BlockRow }) {
  const openMenu = useStore((s) => s.openMenu);
  const createTextBlock = useStore((s) => s.createTextBlock);
  const removeBlock = useStore((s) => s.removeBlock);
  const saveBlockDoc = useStore((s) => s.saveBlockDoc);
  const focusBlockId = useStore((s) => s.focusBlockId);
  const clearFocusBlock = useStore((s) => s.clearFocusBlock);
  const saveTimer = useRef<number | null>(null);
  // The most recent document, kept in a ref so the unmount flush never has to
  // reach for an editor that React may already have destroyed.
  const latestDoc = useRef<JSONContent | null>(null);

  const editor = useEditor({
    extensions: BLOCK_EXTENSIONS,
    content: parseDoc(block.data_json),
    editorProps: {
      attributes: { class: "nb-editor" },
      // Runs before ProseMirror's own keymap (props are resolved before
      // plugins), so returning true pre-empts the default Enter.
      handleKeyDown: (view, event) => {
        if (event.key !== "Enter") return false;
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
        const { state } = view;
        if (!state.selection.empty) return false;
        // A newline inside a code block is content, not a new block.
        if (state.selection.$from.parent.type.name === "codeBlock") return false;
        if (!isAtEndOfNode(state)) return false;

        // Enter at the end of a block starts the next one (plan §9).
        void createTextBlock(block.idea_id, block.id).then((id) => {
          useStore.setState({ focusBlockId: id });
        });
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      latestDoc.current = editor.getJSON();
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        if (latestDoc.current) void saveBlockDoc(block.id, latestDoc.current);
      }, 500);
    },
  });

  // A freshly created block claims the caret once its editor exists.
  useEffect(() => {
    if (!editor || focusBlockId !== block.id) return;
    editor.commands.focus("start");
    clearFocusBlock();
  }, [editor, focusBlockId, block.id, clearFocusBlock]);

  // Flush a pending save if the block unmounts (idea switch, delete) so the
  // last keystrokes aren't lost to the debounce.
  useEffect(() => {
    return () => {
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      if (latestDoc.current) void saveBlockDoc(block.id, latestDoc.current);
    };
  }, [block.id, saveBlockDoc]);

  const copyMarkdown = async () => {
    const markdown = editor.getMarkdown();
    try {
      await navigator.clipboard.writeText(markdown);
    } catch {
      // Older webviews reject the async clipboard; fall back to a selection.
      const scratch = document.createElement("textarea");
      scratch.value = markdown;
      scratch.style.position = "fixed";
      scratch.style.opacity = "0";
      document.body.appendChild(scratch);
      scratch.select();
      document.execCommand("copy");
      scratch.remove();
    }
  };

  const showMenu = (x: number, y: number) => {
    openMenu(x, y, [
      {
        label: "Add block below",
        onSelect: () => {
          void createTextBlock(block.idea_id, block.id).then((id) => {
            useStore.setState({ focusBlockId: id });
          });
        },
      },
      { label: "Copy as Markdown", onSelect: () => void copyMarkdown() },
      { label: "Delete block", danger: true, onSelect: () => void removeBlock(block.id) },
    ]);
  };

  return (
    <div
      className="group relative rounded px-1 py-0.5 transition-colors duration-[120ms] ease-standard hover:bg-surface-raised"
      onContextMenu={(e) => {
        e.preventDefault();
        // Keep the idea-level menu on the article from also firing.
        e.stopPropagation();
        showMenu(e.clientX, e.clientY);
      }}
    >
      <button
        type="button"
        aria-label="Block actions"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          showMenu(rect.left, rect.bottom + 4);
        }}
        className="absolute top-1 -left-7 hidden rounded px-1.5 py-0.5 text-xs text-text-secondary group-hover:block hover:text-accent"
      >
        ⋮
      </button>
      <EditorContent editor={editor} />
    </div>
  );
}

function IdeaView({ idea }: { idea: IdeaRow }) {
  const renameIdea = useStore((s) => s.renameIdea);
  const openMenu = useStore((s) => s.openMenu);
  const askDelete = useStore((s) => s.askDelete);
  const blocks = useStore((s) => s.blocks);
  const blocksFor = useStore((s) => s.blocksFor);
  const blocksLoaded = useStore((s) => s.blocksLoaded);
  const loadBlocks = useStore((s) => s.loadBlocks);
  const createTextBlock = useStore((s) => s.createTextBlock);
  const [draft, setDraft] = useState(idea.title);
  const titleRef = useRef<HTMLInputElement>(null);
  const seeded = useRef(false);

  useEffect(() => setDraft(idea.title), [idea.id, idea.title]);
  useEffect(() => {
    void loadBlocks(idea.id);
  }, [idea.id, loadBlocks]);

  const ready = blocksFor === idea.id && blocksLoaded;

  // An idea always opens with somewhere to type.
  useEffect(() => {
    if (!ready || seeded.current || blocks.length > 0) return;
    seeded.current = true;
    void createTextBlock(idea.id).then((id) => useStore.setState({ focusBlockId: id }));
  }, [ready, blocks.length, idea.id, createTextBlock]);

  const commit = () => {
    if (draft.trim() !== idea.title) void renameIdea(idea.id, draft);
  };

  const appendBlock = () => {
    void createTextBlock(idea.id).then((id) => useStore.setState({ focusBlockId: id }));
  };

  return (
    <article
      className="mx-auto flex h-full max-w-3xl flex-col px-10 py-8"
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, [
          {
            label: "Rename",
            onSelect: () => {
              titleRef.current?.focus();
              titleRef.current?.select();
            },
          },
          { label: "Delete idea", danger: true, onSelect: () => askDelete(idea) },
        ]);
      }}
    >
      <input
        ref={titleRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        spellCheck={false}
        aria-label="Idea title"
        className="w-full bg-transparent text-lg font-semibold outline-none placeholder:text-text-secondary"
        placeholder="Untitled"
      />

      <div className="mt-1 flex items-center gap-3 text-xs text-text-secondary">
        <span>created {new Date(idea.created_at).toLocaleString()}</span>
        <span>·</span>
        <span>edited {new Date(idea.updated_at).toLocaleString()}</span>
        <button
          type="button"
          onClick={() => askDelete(idea)}
          className="ml-auto transition-colors duration-[120ms] ease-standard hover:text-danger"
        >
          Delete
        </button>
      </div>

      <div className="mt-8 flex-1">
        {ready &&
          blocks.map((block) =>
            block.type === "text" ? (
              <TextBlock key={block.id} block={block} />
            ) : (
              // Unknown types are shown, never silently dropped — a blank gap
              // would read as data loss (plan §22's silent-failure theme).
              <div
                key={block.id}
                className="my-1 rounded border border-dashed border-border-subtle px-3 py-2 text-xs text-text-secondary"
              >
                {block.type} block
              </div>
            ),
          )}

        {ready && (
          <button
            type="button"
            onClick={appendBlock}
            className="mt-1 rounded px-1 py-1 text-xs text-text-secondary transition-colors duration-[120ms] ease-standard hover:text-accent"
          >
            + Add block
          </button>
        )}
      </div>
    </article>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <p className="text-xl">An idea notebook.</p>
      <p className="max-w-md text-sm text-text-secondary">
        Every idea is a stack of blocks, and a block can be ink, a photo, a voice memo, or
        a file. Start one with <kbd className="font-mono text-text-primary">Ctrl+K</kbd>.
      </p>
      <button
        type="button"
        onClick={onNew}
        className="rounded bg-accent px-3 py-1.5 text-sm text-on-accent transition-opacity duration-[120ms] ease-standard hover:opacity-90"
      >
        New idea
      </button>
    </div>
  );
}

interface Command {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

function CommandPalette({ onClose, onNavigate }: { onClose: () => void; onNavigate: (h: string) => void }) {
  const ideas = useStore((s) => s.ideas);
  const createIdea = useStore((s) => s.createIdea);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(() => {
    const all: Command[] = [
      {
        id: "__new",
        label: "New idea",
        hint: "create",
        run: () => {
          void createIdea().then((id) => onNavigate(`#/idea/${id}`));
          onClose();
        },
      },
      ...ideas.map((idea) => ({
        id: idea.id,
        label: idea.title,
        hint: "open",
        run: () => {
          onNavigate(`#/idea/${idea.id}`);
          onClose();
        },
      })),
    ];
    const needle = query.trim().toLowerCase();
    return needle ? all.filter((c) => c.label.toLowerCase().includes(needle)) : all;
  }, [ideas, query, createIdea, onNavigate, onClose]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setIndex(0), [query]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, commands.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commands[index]?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[rgb(0_0_0/0.35)] pt-[12vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        className="w-[36rem] max-w-[92vw] overflow-hidden rounded border border-border-subtle bg-surface-raised shadow-[0_4px_12px_rgb(0_0_0/0.08)]"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search ideas, or run a command…"
          spellCheck={false}
          className="w-full border-b border-border-subtle bg-transparent px-4 py-3 text-base outline-none placeholder:text-text-secondary focus:border-accent"
        />
        <ul className="max-h-80 overflow-y-auto py-1">
          {commands.length === 0 ? (
            <li className="px-4 py-3 text-sm text-text-secondary">Nothing matches.</li>
          ) : (
            commands.map((c, i) => (
              <li key={c.id}>
                <button
                  type="button"
                  onMouseEnter={() => setIndex(i)}
                  onClick={c.run}
                  className={[
                    "relative flex w-full items-center gap-3 py-2 pr-4 pl-5 text-left text-sm",
                    i === index ? "bg-surface-sunken text-text-primary" : "text-text-secondary",
                  ].join(" ")}
                >
                  {i === index && (
                    <span
                      aria-hidden
                      className="absolute top-1.5 bottom-1.5 left-2 w-0.5 rounded-full bg-accent"
                    />
                  )}
                  <span className="truncate">{c.label}</span>
                  <span className={["ml-auto text-xs", i === index ? "text-accent" : ""].join(" ")}>
                    {c.hint}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "Day" },
  { value: "dark", label: "Night" },
  { value: "system", label: "System" },
];

function ThemePanel() {
  const theme = useStore((s) => s.theme);
  const accent = useStore((s) => s.accent);
  const setTheme = useStore((s) => s.setTheme);
  const setAccent = useStore((s) => s.setAccent);
  const setThemeOpen = useStore((s) => s.setThemeOpen);
  const [hexDraft, setHexDraft] = useState(accent ?? "");

  useEffect(() => setHexDraft(accent ?? ""), [accent]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setThemeOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setThemeOpen]);

  const resolved = resolveTheme(theme);
  const effective = accent ?? THEME_ACCENT[resolved];

  const commitHex = () => {
    const normalized = normalizeHex(hexDraft);
    if (normalized) void setAccent(normalized);
    else setHexDraft(accent ?? "");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[rgb(0_0_0/0.35)] pt-[12vh]"
      onClick={() => setThemeOpen(false)}
    >
      <div
        role="dialog"
        aria-label="Theme"
        className="w-[26rem] max-w-[92vw] rounded border border-border-subtle bg-surface-raised p-5 shadow-[0_4px_12px_rgb(0_0_0/0.08)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">Theme</h2>

        <p className="mt-4 text-xs uppercase tracking-wide text-text-secondary">Appearance</p>
        <div className="mt-2 grid grid-cols-3 gap-1 rounded border border-border-subtle p-1">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => void setTheme(option.value)}
              aria-pressed={theme === option.value}
              className={[
                "rounded px-2 py-1.5 text-sm transition-colors duration-[120ms] ease-standard",
                theme === option.value
                  ? "bg-accent text-on-accent"
                  : "text-text-secondary hover:text-text-primary",
              ].join(" ")}
            >
              {option.label}
            </button>
          ))}
        </div>

        <p className="mt-5 text-xs uppercase tracking-wide text-text-secondary">Accent</p>
        <div className="mt-2 flex items-center gap-2">
          <input
            type="color"
            aria-label="Accent colour"
            value={effective}
            onChange={(e) => void setAccent(e.target.value)}
            className="h-8 w-10 cursor-pointer rounded border border-border-subtle bg-surface-raised"
          />
          <input
            value={hexDraft}
            onChange={(e) => setHexDraft(e.target.value)}
            onBlur={commitHex}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitHex();
              }
            }}
            placeholder={effective}
            spellCheck={false}
            aria-label="Accent hex code"
            className="w-28 rounded border border-border-subtle bg-surface-base px-2 py-1 font-mono text-sm outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={() => void setAccent(null)}
            disabled={accent === null}
            className="ml-auto rounded px-2 py-1 text-xs text-text-secondary transition-colors duration-[120ms] ease-standard hover:text-text-primary disabled:opacity-40"
          >
            Default
          </button>
        </div>
        <p className="mt-2 text-xs text-text-secondary">
          {accent ? `Using ${accent} in both day and night.` : `Using the ${resolved} default.`}
        </p>
      </div>
    </div>
  );
}

function ContextMenu() {
  const menu = useStore((s) => s.menu);
  const closeMenu = useStore((s) => s.closeMenu);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [index, setIndex] = useState(0);

  // Place the panel at the cursor, then pull it back inside the viewport. This
  // runs before paint, so the clamped position is the only one ever seen.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!menu || !panel) return;
    setIndex(0);
    const { width, height } = panel.getBoundingClientRect();
    const pad = 6;
    setPos({
      x: Math.max(pad, Math.min(menu.x, window.innerWidth - width - pad)),
      y: Math.max(pad, Math.min(menu.y, window.innerHeight - height - pad)),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const count = menu.items.length;

    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((i) => (i + 1) % count);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => (i - 1 + count) % count);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = menu.items[index];
        closeMenu();
        item?.onSelect();
      }
    };

    // Capture phase, so a click anywhere else dismisses before it does its job.
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("blur", closeMenu);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("blur", closeMenu);
    };
  }, [menu, index, closeMenu]);

  if (!menu) return null;

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label="Actions"
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-[60] min-w-[11rem] overflow-hidden rounded border border-border-subtle bg-surface-raised py-1 shadow-[0_8px_24px_rgb(0_0_0/0.18)]"
    >
      {menu.items.map((item, i) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onMouseEnter={() => setIndex(i)}
          onClick={() => {
            closeMenu();
            item.onSelect();
          }}
          className={[
            "block w-full truncate px-3 py-1.5 text-left text-sm",
            "transition-colors duration-[120ms] ease-standard",
            item.danger ? "text-danger" : "text-text-primary",
            i === index ? "bg-surface-sunken" : "",
          ].join(" ")}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-[rgb(0_0_0/0.35)]"
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="w-80 max-w-[92vw] rounded border border-border-subtle bg-surface-raised p-5 shadow-[0_8px_24px_rgb(0_0_0/0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-2 text-sm text-text-secondary">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          {/* Cancel holds focus: a destructive default is a bad default. */}
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-sm text-text-secondary transition-colors duration-[120ms] ease-standard hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded bg-danger px-3 py-1.5 text-sm text-on-danger transition-opacity duration-[120ms] ease-standard hover:opacity-90"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const { ideaId, navigate } = useHashRoute();
  const ready = useStore((s) => s.ready);
  const error = useStore((s) => s.error);
  const ideas = useStore((s) => s.ideas);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const setPalette = useStore((s) => s.setPalette);
  const createIdea = useStore((s) => s.createIdea);
  const theme = useStore((s) => s.theme);
  const accent = useStore((s) => s.accent);
  const themeOpen = useStore((s) => s.themeOpen);
  const pendingDelete = useStore((s) => s.pendingDelete);
  const cancelDelete = useStore((s) => s.cancelDelete);
  const confirmDelete = useStore((s) => s.confirmDelete);

  const selected = useMemo(() => ideas.find((i) => i.id === ideaId) ?? null, [ideas, ideaId]);

  const newIdea = useCallback(async () => {
    navigate(`#/idea/${await createIdea()}`);
  }, [createIdea, navigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+K only. plan §29 says Mod+K, but on this machine Super/Meta+K is
      // the OS palette, so Meta is deliberately excluded (local divergence).
      if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette(!useStore.getState().paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPalette]);

  // Paint the theme onto <html>. `system` follows the OS live.
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      root.dataset.theme = resolveTheme(theme);
    };
    apply();
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  // One inline custom property drives every accent-coloured pixel. A null
  // accent removes it, letting the theme's own accent through (plan §28).
  useEffect(() => {
    const root = document.documentElement;
    if (accent) root.style.setProperty("--color-accent", accent);
    else root.style.removeProperty("--color-accent");
  }, [accent]);

  if (!ready) return <Splash />;
  if (error) return <BootError error={error} />;

  return (
    <div className="flex h-full">
      <Sidebar
        activeId={ideaId}
        onOpen={(id) => navigate(`#/idea/${id}`)}
        onNew={() => void newIdea()}
      />
      <main className="min-w-0 flex-1 overflow-y-auto">
        {selected ? (
          <IdeaView key={selected.id} idea={selected} />
        ) : (
          <EmptyState onNew={() => void newIdea()} />
        )}
      </main>
      {paletteOpen && (
        <CommandPalette onClose={() => setPalette(false)} onNavigate={navigate} />
      )}
      {themeOpen && <ThemePanel />}
      <ContextMenu />
      {pendingDelete && (
        <ConfirmDialog
          title="Delete idea?"
          body={`“${pendingDelete.title}” will be deleted. This can’t be undone yet.`}
          onConfirm={() => {
            const doomed = pendingDelete.id;
            void confirmDelete().then(() => {
              if (doomed === ideaId) navigate("#/");
            });
          }}
          onCancel={cancelDelete}
        />
      )}
    </div>
  );
}

/* ──────────────────────────── App chrome ────────────────────────────────── */

// The webview's native context menu is a browser affordance, not a product one:
// right-click offers Reload / Back / Inspect Element. Suppress it app-wide — our
// own menu (the `ContextMenu` component) takes over where it matters, and the
// block system adds its own entries in plan §9. Trade-off: right-click-to-paste
// on text fields goes with it; Ctrl/Cmd+V still works.
//
// Dev escape hatch: this menu was the only way into the web inspector on Linux,
// so Shift+right-click still opens it while developing. Release builds suppress
// unconditionally.
window.addEventListener("contextmenu", (e) => {
  if (import.meta.env.DEV && e.shiftKey) return;
  e.preventDefault();
});

createRoot(document.getElementById("root")!).render(<App />);
void boot();
