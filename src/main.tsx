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
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { appConfigDir } from "@tauri-apps/api/path";
import { getVersion } from "@tauri-apps/api/app";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import { Placeholder } from "@tiptap/extension-placeholder";
import { decodeHtmlEntities, isAtEndOfNode, type Editor, type JSONContent } from "@tiptap/core";
import { generateKeyBetween } from "fractional-indexing";
import {
  Fragment,
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

/** One file in an export tree. `path` is relative to the export root. */
export interface ExportTextFile {
  path: string;
  contents: string;
}

/** A file copied out of the local blob store, byte-for-byte (never via IPC). */
export interface ExportBlobCopy {
  path: string;
  source: string;
}

export interface ExportSummary {
  /** The exported folder, as it will read in a file manager. */
  folder: string;
  /** File names written, in export order. */
  ideas: string[];
  bytes: number;
  blobs: number;
  linksRewritten: number;
  /**
   * Everything the export could not represent faithfully, in plain words:
   * unresolved links, heading links left as wikilinks, media with no blob, and
   * block types markdown cannot carry. Plan §17 is explicit that reporting what
   * did not survive matters more than a silent success.
   */
  notes: string[];
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
    /** Native folder chooser. `null` when the user cancels. */
    pickDirectory(title: string): Promise<string | null>;
  };
  exporter: {
    writeTree(dest: string, files: ExportTextFile[], blobs: ExportBlobCopy[]): Promise<void>;
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
  pickDirectory: notYet("dialog.pickDirectory"),
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
    dialog: {
      ...stubDialog(),
      // The picker is the one dialog piece week 2 needs; picking *files* (media
      // import, §11) and saving single files stay stubbed until then.
      pickDirectory: async (title) => {
        const picked = await open({ directory: true, multiple: false, title });
        return typeof picked === "string" ? picked : null;
      },
    },
    exporter: {
      writeTree: (dest, files, blobs) => invoke("export_write_tree", { dest, files, blobs }),
    },
    mic: stubMic(),
    app: {
      vaultRoot: () => appConfigDir(),
      version: () => getVersion(),
    },
  };
}

/**
 * The in-memory platform, plus the state a test wants to read back.
 */
export interface MemoryPlatformHandle extends Platform {
  /** `"<dest>/<path>"` → file contents. */
  written: Map<string, string>;
  /** `"<dest>/<path>"` → the source path that was copied. */
  copied: Map<string, string>;
}

/**
 * In-memory Maps, for Vitest in a plain Node process — no webview, no Rust.
 * The row store lands with the test harness in week 3; until then this is the
 * seam and nothing more.
 *
 * `exporter` is real rather than stubbed: it is the one capability that is
 * pure tree-building, so week 3's export tests can assert the exact tree
 * without a filesystem.
 */
export function MemoryPlatform(): MemoryPlatformHandle {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  void tables; // week 3 fills this in
  const written = new Map<string, string>();
  const copied = new Map<string, string>();
  return {
    db: { all: notYet("MemoryPlatform.db.all"), run: notYet("MemoryPlatform.db.run") },
    fs: stubFs(),
    hash: { sha256: notYet("hash.sha256") },
    dialog: {
      ...stubDialog(),
      pickDirectory: async () => "memory://vault/export",
    },
    exporter: {
      async writeTree(dest, files, blobs) {
        for (const file of files) written.set(`${dest}/${file.path}`, file.contents);
        for (const blob of blobs) copied.set(`${dest}/${blob.path}`, blob.source);
      },
    },
    mic: stubMic(),
    app: {
      vaultRoot: async () => "memory://vault",
      version: async () => "0.0.0-memory",
    },
    written,
    copied,
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

/**
 * A one-off result message. Export is the first action that has something worth
 * reporting — plan §17 is explicit that reporting beats silence — and it doubles
 * as the way a failure is surfaced instead of swallowed.
 */
interface Notice {
  kind: "ok" | "error";
  title: string;
  lines: string[];
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
  /** True while an export is picking a folder or writing. */
  exporting: boolean;
  notice: Notice | null;
  blocks: BlockRow[];
  /** Which idea `blocks` belongs to; guards against a stale async load. */
  blocksFor: string | null;
  blocksLoaded: boolean;
  /** Set after creating a block so the new editor can claim the caret. */
  focusBlockId: string | null;
  /** The block whose editor last held focus — where palette formats land. */
  activeBlockId: string | null;
  setPalette(open: boolean): void;
  setThemeOpen(open: boolean): void;
  setTheme(mode: ThemeMode): Promise<void>;
  setAccent(hex: string | null): Promise<void>;
  openMenu(x: number, y: number, items: MenuItem[]): void;
  closeMenu(): void;
  askDelete(idea: IdeaRow): void;
  cancelDelete(): void;
  confirmDelete(): Promise<void>;
  dismissNotice(): void;
  exportIdea(id: string): Promise<void>;
  clearFocusBlock(): void;
  setActiveBlock(id: string | null): void;
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
  exporting: false,
  notice: null,
  blocks: [],
  blocksFor: null,
  blocksLoaded: false,
  focusBlockId: null,
  activeBlockId: null,

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

  dismissNotice: () => set({ notice: null }),

  /**
   * Export an idea as a markdown folder (plan §17). Picking a folder is the only
   * cancellation path and cancelling is not a failure, so it simply stops; a
   * real failure is reported in the notice rather than thrown into the void.
   */
  async exportIdea(id) {
    if (get().exporting) return;
    const idea = get().ideas.find((row) => row.id === id);
    if (!idea) return;

    set({ exporting: true });
    try {
      const dest = await platform.dialog.pickDirectory(`Export “${idea.title}” into…`);
      if (!dest) return;
      const summary = await exportIdeaTree(idea, dest);
      set({
        notice: { kind: "ok", title: `Exported “${idea.title}”`, lines: exportLines(summary) },
      });
    } catch (err) {
      set({
        notice: {
          kind: "error",
          title: "Export failed",
          lines: [err instanceof Error ? err.message : String(err)],
        },
      });
    } finally {
      set({ exporting: false });
    }
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
  setActiveBlock: (id) => set({ activeBlockId: id }),

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
  const exportIdea = useStore((s) => s.exportIdea);

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
                          { label: "Export as Markdown…", onSelect: () => void exportIdea(idea.id) },
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
 * Live editors by block id. Each block owns its editor (plan §9), so "the block
 * I'm typing in" can only be answered by looking one up — the palette needs this
 * to apply a format to whatever the user was last editing.
 */
const blockEditors = new Map<string, Editor>();

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

/* ────────────── Export (plan §17: the markdown-folder format) ────────────── */

/**
 * Export an idea as a folder of markdown, Obsidian-ready.
 *
 * This is §17's Obsidian import read backwards: the same mapping table,
 * traversed outward. One `.md` per idea, YAML frontmatter carrying the idea
 * metadata, `[[wikilinks]]` rewritten to relative markdown links, and an
 * `attachments/` folder for whatever media the idea carries.
 *
 * §17 lists three exports (whole vault, single-idea `.html`, JSON). This is a
 * deliberate fourth: it is the format that makes the data portable *today*, to
 * Obsidian or any other tool, and it round-trips through the importer.
 *
 * What is honest about the current state: there are no `image`/`audio` blocks
 * and no blob store yet (plan §11–12), so `attachments/` stays empty and media
 * references are reported rather than half-exported. The plumbing is here, so
 * both populate the day those blocks land.
 */

/** Windows-hostile and Obsidian-hostile characters, plus markdown's `[]`. */
const BAD_FILENAME_CHARS = /[\\/:*?"<>|#^[\]]/g;
/** Control characters: invisible in a listing, unopenable in some tools. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * A title is user text; a filename is not. This sanitises rather than formats,
 * so the result is always one valid path segment — plan §18's "never
 * interpolate user-supplied filenames into paths".
 */
function sanitizeFileName(title: string, fallback = "Untitled"): string {
  const cleaned = title
    .replace(BAD_FILENAME_CHARS, "")
    .replace(CONTROL_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    // A trailing dot or space is legal on Linux and a trap on Windows.
    .replace(/[. ]+$/, "")
    .trim();
  return cleaned || fallback;
}

/**
 * `Title`, `Title 2`, `Title 3`… Case-insensitively unique, because a vault
 * synced onto a case-insensitive filesystem silently merges `Note` and `note`.
 */
function uniqueFileName(base: string, used: Set<string>): string {
  const taken = (name: string) => used.has(name.toLowerCase());
  if (!taken(base)) {
    used.add(base.toLowerCase());
    return base;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken(candidate)) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

/**
 * `[[Target]]`, `[[Target|alias]]`, `[[Target#heading]]`, `![[…]]` (plan §13).
 *
 * This matches the *serialized* form, and that is not incidental. The Markdown
 * extension escapes ``\ ` * _ [ ] ~`` in ordinary text (`encodeTextForMarkdown`
 * → `escapeMarkdownSyntax`) and deliberately skips that inside code blocks and
 * `code` marks. So a wikilink the user typed arrives as `\[\[Target\]\]`, and a
 * `[[Target]]` that is *not* escaped is inside code — where rewriting it would
 * be wrong. Matching the escaped form is therefore both necessary and exactly
 * the right filter: code protects itself, with no special case.
 */
const ESCAPED_WIKILINK_RE = /(!?)\\\[\\\[([^\n]*?)\\\]\\\]/g;

/** The inverse of `escapeMarkdownSyntax`, for one matched run of text. */
const MARKDOWN_ESCAPE_RE = /\\([\\`*_[\]~])/g;

function unescapeMarkdownText(text: string): string {
  // On the way out, entity encoding happens *before* backslash escaping, so on
  // the way back it comes off *after* unescaping.
  return decodeHtmlEntities(text.replace(MARKDOWN_ESCAPE_RE, "$1"));
}

interface WikilinkParts {
  target: string;
  heading: string | null;
  alias: string | null;
}

interface Wikilink extends WikilinkParts {
  /** Exactly what the serializer emitted, escapes and all. */
  raw: string;
  /** The unescaped inner text, e.g. `Target|alias`. */
  body: string;
  embed: boolean;
}

/** Split a wikilink body into its target, heading and alias (plan §13). */
function parseWikilinkBody(inner: string): WikilinkParts {
  const bar = inner.indexOf("|");
  const head = (bar === -1 ? inner : inner.slice(0, bar)).trim();
  const alias = bar === -1 ? null : inner.slice(bar + 1);
  const hash = head.indexOf("#");
  if (hash === -1) return { target: head, heading: null, alias };
  return {
    target: head.slice(0, hash).trim(),
    heading: head.slice(hash + 1).trim(),
    alias,
  };
}

/** Every wikilink in a block's markdown, as the user wrote it. */
function extractWikilinks(markdown: string): Wikilink[] {
  const links: Wikilink[] = [];
  for (const match of markdown.matchAll(ESCAPED_WIKILINK_RE)) {
    const body = unescapeMarkdownText(match[2]);
    links.push({ raw: match[0], embed: match[1] === "!", body, ...parseWikilinkBody(body) });
  }
  return links;
}

/** Extension-checked, so a note embed (`![[Note]]`) is not read as a file. */
const MEDIA_TARGET_RE =
  /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|svg|heic|mp3|m4a|aac|wav|ogg|oga|opus|flac|mp4|mov|m4v|webm|mkv|pdf)$/i;

function isMediaTarget(target: string): boolean {
  return MEDIA_TARGET_RE.test(target.trim());
}

/** Brackets cannot appear in a wikilink body, but `*` and friends still can. */
function escapeLinkText(text: string): string {
  return text.replace(/[\\`*_~]/g, (char) => `\\${char}`);
}

/**
 * Plan §17 maps YAML frontmatter onto idea metadata, so exporting it is what
 * makes export → import lossless. JSON strings are also valid YAML
 * double-quoted scalars, which handles `:`, `#` and quotes for free.
 */
function frontmatter(idea: IdeaRow): string {
  return [
    "---",
    `title: ${JSON.stringify(idea.title)}`,
    `created: ${new Date(idea.created_at).toISOString()}`,
    `updated: ${new Date(idea.updated_at).toISOString()}`,
    "---",
  ].join("\n");
}

let headlessMarkdown: MarkdownManager | null = null;

/**
 * The serializer for blocks that have no live editor. Any mounted block already
 * has one — the Markdown extension builds it from the same extension list — so
 * this is only a fallback: an unmounted block still has to serialize correctly,
 * or a large idea would export short.
 */
function markdownManager(): MarkdownManager {
  for (const editor of blockEditors.values()) return editor.storage.markdown.manager;
  headlessMarkdown ??= new MarkdownManager({ extensions: BLOCK_EXTENSIONS });
  return headlessMarkdown;
}

/**
 * One block as markdown. A mounted block's editor is the live source — it may
 * hold keystrokes the 500 ms autosave has not written yet — with the stored
 * document as the fallback.
 */
function blockMarkdown(block: BlockRow): string {
  const live = blockEditors.get(block.id);
  if (live) return live.getMarkdown();

  let doc: JSONContent;
  try {
    doc = JSON.parse(block.data_json) as JSONContent;
  } catch (err) {
    // Never write out half an idea: an unreadable block is a bug to surface,
    // not content to quietly drop (plan §22).
    throw new Error(`block ${block.id} has unreadable data_json (${String(err)})`);
  }
  return markdownManager().serialize(doc);
}

/**
 * One idea's blocks as a single markdown document. Each block is its own editor
 * (plan §9), so a block boundary is exactly one paragraph break.
 */
function ideaMarkdown(blocks: BlockRow[], unsupported: Record<string, number>): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(blockMarkdown(block));
      continue;
    }
    // An honest gap rather than an invisible one (plan §22): the type is
    // counted in the report and the spot is marked in the file. Every markdown
    // renderer ignores an HTML comment.
    unsupported[block.type] = (unsupported[block.type] ?? 0) + 1;
    parts.push(`<!-- sketchback: a ${block.type} block sits here; markdown cannot represent it -->`);
  }
  return parts
    .map((part) => part.replace(/\s+$/, ""))
    .filter((part) => part !== "")
    .join("\n\n");
}

interface LinkStats {
  rewritten: number;
  kept: string[];
  unresolved: string[];
  missing: string[];
}

/**
 * Rewrite resolved `[[wikilinks]]` into relative markdown links.
 *
 * Standard links are the target because the export is for "Obsidian *or any
 * other tool*": Obsidian understands both, other tools only understand the
 * first. Where converting would lose meaning the wikilink is written back in
 * Obsidian's own syntax — where it still resolves — and reported, rather than
 * quietly mangled.
 */
function rewriteWikilinks(
  markdown: string,
  resolveFile: (target: string) => string | null,
  stats: LinkStats,
): string {
  return markdown.replace(ESCAPED_WIKILINK_RE, (raw: string, bang: string, inner: string) => {
    const body = unescapeMarkdownText(inner);
    const { target, heading, alias } = parseWikilinkBody(body);
    if (!target) return raw;

    // Written back the way Obsidian writes it — a plain `[[…]]`, not an escaped
    // one — so it still behaves as a link (or an unresolved link) there.
    const keep = () => `${bang}[[${body}]]`;

    // A media embed (`![[photo.png]]`). The blob store is plan §12 and does not
    // exist yet, so there is genuinely nothing to copy; pointing at a file that
    // is not there would be worse than leaving the embed as it stands.
    if (isMediaTarget(target)) {
      stats.missing.push(target);
      return keep();
    }

    // `[[Note#Heading]]`. Markdown has no equivalent of Obsidian's heading link,
    // so it stays a wikilink — and the note is exported beside it, so it keeps
    // working inside Obsidian.
    if (heading) {
      stats.kept.push(target);
      return keep();
    }

    const file = resolveFile(target);
    if (!file) {
      stats.unresolved.push(target);
      return keep();
    }

    stats.rewritten += 1;
    // An `![[Note]]` transclusion degrades to a plain link: the only faithful
    // markdown equivalent, and the note itself is in the folder.
    return `[${escapeLinkText(alias ?? target)}](${encodeURI(file)})`;
  });
}

/** How many ideas one export follows links through before it stops. */
const MAX_EXPORT_IDEAS = 200;

/** `a, b, c +3 more` — a report line, not an exhaustive list. */
function summarizeList(items: string[], max = 4): string {
  const unique = [...new Set(items)];
  const shown = unique.slice(0, max).join(", ");
  return unique.length > max ? `${shown} +${unique.length - max} more` : shown;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Every block of `ideaId`. The open idea is read from the store first, so a
 * block created moments ago is included even if its insert is still in flight.
 */
async function blocksForIdea(ideaId: string): Promise<BlockRow[]> {
  const live = useStore.getState();
  if (live.blocksFor === ideaId && live.blocksLoaded) return live.blocks;
  return platform.db.all<BlockRow>(SQL.listBlocks, [ideaId]);
}

/** Build the export tree and write it. Returns what happened, to be reported. */
async function exportIdeaTree(idea: IdeaRow, destParent: string): Promise<ExportSummary> {
  const folder = sanitizeFileName(idea.title);
  const unsupported: Record<string, number> = {};
  const stats: LinkStats = { rewritten: 0, kept: [], unresolved: [], missing: [] };

  // Resolve `[[Title]]` against every live idea (plan §13). Matched
  // case-insensitively, because nobody types titles consistently.
  const byTitle = new Map<string, IdeaRow>();
  for (const row of await platform.db.all<IdeaRow>(SQL.listIdeas)) {
    const key = row.title.trim().toLowerCase();
    if (key && !byTitle.has(key)) byTitle.set(key, row);
  }

  // Pass 1: walk the link graph. Every file name must be known before any link
  // is rewritten, and the walk has to happen before the write so a link to an
  // idea can point at a file that definitely exists. Order is breadth-first
  // from the idea the user asked for.
  const byId = new Map<string, IdeaRow>();
  const markdownById = new Map<string, string>();
  const nameById = new Map<string, string>();
  const usedNames = new Set<string>();
  const queue: IdeaRow[] = [idea];

  while (queue.length > 0 && byId.size < MAX_EXPORT_IDEAS) {
    const current = queue.shift() as IdeaRow;
    if (byId.has(current.id)) continue;
    byId.set(current.id, current);

    const markdown = ideaMarkdown(await blocksForIdea(current.id), unsupported);
    markdownById.set(current.id, markdown);
    nameById.set(current.id, uniqueFileName(sanitizeFileName(current.title), usedNames));

    for (const link of extractWikilinks(markdown)) {
      if (!link.target || isMediaTarget(link.target)) continue;
      const linked = byTitle.get(link.target.toLowerCase());
      if (linked && !byId.has(linked.id)) queue.push(linked);
    }
  }

  const truncated = byId.size >= MAX_EXPORT_IDEAS;

  const resolveFile = (target: string): string | null => {
    const linked = byTitle.get(target.trim().toLowerCase());
    const name = linked ? nameById.get(linked.id) : undefined;
    return name ? `${name}.md` : null;
  };

  // Pass 2: rewrite links, prepend frontmatter, assemble.
  const files: ExportTextFile[] = [];
  const encoder = new TextEncoder();
  let bytes = 0;

  for (const [id, markdown] of markdownById) {
    const contents = `${frontmatter(byId.get(id) as IdeaRow)}\n\n${rewriteWikilinks(markdown, resolveFile, stats)}\n`;
    bytes += encoder.encode(contents).length;
    files.push({ path: `${folder}/${nameById.get(id)}.md`, contents });
  }

  // Empty until media blocks exist (plan §11–12): the folder appears on the day
  // there is something to put in it, rather than as an empty directory.
  const blobs: ExportBlobCopy[] = [];

  await platform.exporter.writeTree(destParent, files, blobs);

  const notes: string[] = [];
  if (stats.unresolved.length > 0) {
    notes.push(`Links to ideas that don't exist: ${summarizeList(stats.unresolved)}`);
  }
  if (stats.kept.length > 0) {
    notes.push(`Heading links left as [[wikilinks]]: ${summarizeList(stats.kept)}`);
  }
  if (stats.missing.length > 0) {
    notes.push(`Media referenced but not in the vault: ${summarizeList(stats.missing)}`);
  }
  for (const [type, count] of Object.entries(unsupported)) {
    notes.push(`${count} ${type} block${count === 1 ? "" : "s"} could not be written as markdown`);
  }
  if (truncated) {
    notes.push(`Stopped after ${MAX_EXPORT_IDEAS} ideas; the rest of the link graph was not followed`);
  }

  return {
    folder: `${destParent}/${folder}`,
    ideas: [...nameById.values()].map((name) => `${name}.md`),
    bytes,
    blobs: blobs.length,
    linksRewritten: stats.rewritten,
    notes,
  };
}

/** The report lines shown after an export, in reading order. */
function exportLines(summary: ExportSummary): string[] {
  const lines = [
    `${summary.ideas.length} file${summary.ideas.length === 1 ? "" : "s"}, ${formatBytes(summary.bytes)}`,
    summary.folder,
  ];
  if (summary.linksRewritten > 0) {
    lines.push(`${summary.linksRewritten} link${summary.linksRewritten === 1 ? "" : "s"} rewritten`);
  }
  if (summary.blobs > 0) {
    lines.push(`${summary.blobs} attachment${summary.blobs === 1 ? "" : "s"} copied`);
  }
  return [...lines, ...summary.notes];
}

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
  const setActiveBlock = useStore((s) => s.setActiveBlock);
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
    // Remember where the caret was, so a palette format has a target even after
    // focus has moved to the palette input.
    onFocus: () => setActiveBlock(block.id),
  });

  // Publish this editor so the palette can reach it (see `blockEditors`).
  useEffect(() => {
    blockEditors.set(block.id, editor);
    return () => {
      blockEditors.delete(block.id);
    };
  }, [block.id, editor]);

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
  const exportIdea = useStore((s) => s.exportIdea);
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
          { label: "Export as Markdown…", onSelect: () => void exportIdea(idea.id) },
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
          onClick={() => void exportIdea(idea.id)}
          className="ml-auto transition-colors duration-[120ms] ease-standard hover:text-accent"
        >
          Export as Markdown
        </button>
        <button
          type="button"
          onClick={() => askDelete(idea)}
          className="transition-colors duration-[120ms] ease-standard hover:text-danger"
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
  /** Rendered as a heading above the first row of each run (see `rows`). */
  group?: string;
  /** Extra search terms, so the palette matches names *and* syntax. */
  keywords?: string[];
  run: () => void;
}

/**
 * The markdown formats the palette can apply to the current block. This is
 * deliberately the same set plan §9 turns into inline shortcuts, exposed as a
 * list so nobody has to remember `**` to get bold. `hint` shows the syntax, so
 * the palette doubles as a shortcut cheat-sheet.
 *
 * Links are not here: they need a URL step, so the palette handles them itself.
 */
interface MarkdownCommand {
  id: string;
  label: string;
  hint: string;
  keywords: string[];
  apply: (editor: Editor) => void;
}

const MARKDOWN_COMMANDS: MarkdownCommand[] = [
  {
    id: "md-p",
    label: "Paragraph",
    hint: "plain text",
    keywords: ["paragraph", "body", "plain", "text", "p"],
    apply: (e) => e.chain().focus().setParagraph().run(),
  },
  {
    id: "md-h1",
    label: "Heading 1",
    hint: "#",
    keywords: ["h1", "heading", "title", "#"],
    apply: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    id: "md-h2",
    label: "Heading 2",
    hint: "##",
    keywords: ["h2", "heading", "subtitle", "###"],
    apply: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    id: "md-h3",
    label: "Heading 3",
    hint: "###",
    keywords: ["h3", "heading", "###"],
    apply: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    id: "md-bold",
    label: "Bold",
    hint: "**bold**",
    keywords: ["bold", "strong", "**"],
    apply: (e) => e.chain().focus().toggleBold().run(),
  },
  {
    id: "md-italic",
    label: "Italic",
    hint: "*italic*",
    keywords: ["italic", "emphasis", "em", "*"],
    apply: (e) => e.chain().focus().toggleItalic().run(),
  },
  {
    id: "md-strike",
    label: "Strikethrough",
    hint: "~~strike~~",
    keywords: ["strike", "strikethrough", "~~"],
    apply: (e) => e.chain().focus().toggleStrike().run(),
  },
  {
    id: "md-code",
    label: "Inline code",
    hint: "`code`",
    keywords: ["code", "inline", "mono", "`"],
    apply: (e) => e.chain().focus().toggleCode().run(),
  },
  {
    id: "md-pre",
    label: "Code block",
    hint: "```",
    keywords: ["codeblock", "code block", "pre", "fence", "```"],
    apply: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
  {
    id: "md-ul",
    label: "Bullet list",
    hint: "-",
    keywords: ["bullet", "unordered", "list", "ul", "-"],
    apply: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    id: "md-ol",
    label: "Numbered list",
    hint: "1.",
    keywords: ["number", "numbered", "ordered", "list", "ol", "1."],
    apply: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    id: "md-quote",
    label: "Quote",
    hint: ">",
    keywords: ["quote", "blockquote", ">"],
    apply: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    id: "md-hr",
    label: "Divider",
    hint: "---",
    keywords: ["divider", "rule", "horizontal", "hr", "---"],
    apply: (e) => e.chain().focus().setHorizontalRule().run(),
  },
  {
    id: "md-clear",
    label: "Clear formatting",
    hint: "unset",
    keywords: ["clear", "remove", "unset", "plain", "reset"],
    apply: (e) => e.chain().focus().unsetAllMarks().clearNodes().run(),
  },
];

/** `example.com` → `https://example.com`, while leaving schemes and anchors be. */
function normalizeHref(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("#")) return trimmed;
  return `https://${trimmed}`;
}

function CommandPalette({
  onClose,
  onNavigate,
  openIdea,
}: {
  onClose: () => void;
  onNavigate: (h: string) => void;
  /** The idea in view, or null on the empty state — export needs a subject. */
  openIdea: IdeaRow | null;
}) {
  const ideas = useStore((s) => s.ideas);
  const blocks = useStore((s) => s.blocks);
  const activeBlockId = useStore((s) => s.activeBlockId);
  const createIdea = useStore((s) => s.createIdea);
  const exportIdea = useStore((s) => s.exportIdea);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  // Non-null while collecting the URL for the Link command.
  const [linkEditor, setLinkEditor] = useState<Editor | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The block the user was last typing in, falling back to the first live block
  // so the text commands still work once focus has wandered.
  const target = useMemo<Editor | null>(() => {
    const active = activeBlockId ? blockEditors.get(activeBlockId) : undefined;
    if (active) return active;
    for (const block of blocks) {
      const editor = blockEditors.get(block.id);
      if (editor) return editor;
    }
    return null;
  }, [activeBlockId, blocks]);

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
    ];

    // Only offered with an idea in view — there would be nothing to export.
    if (openIdea) {
      all.push({
        id: "__export",
        label: "Export as Markdown folder",
        hint: "obsidian",
        keywords: ["export", "markdown", "md", "obsidian", "folder", "vault", "save", "download"],
        run: () => {
          void exportIdea(openIdea.id);
          onClose();
        },
      });
    }

    // Only offered when there is a block to format — otherwise they would be
    // commands that cannot do anything.
    if (target) {
      for (const md of MARKDOWN_COMMANDS) {
        all.push({
          id: md.id,
          label: md.label,
          hint: md.hint,
          group: "Text",
          keywords: md.keywords,
          run: () => {
            md.apply(target);
            onClose();
          },
        });
      }
      all.push({
        id: "md-link",
        label: "Link",
        hint: "[text](url)",
        group: "Text",
        keywords: ["link", "url", "href", "["],
        run: () => {
          setQuery("");
          setLinkEditor(target);
        },
      });
    }

    for (const idea of ideas) {
      all.push({
        id: idea.id,
        label: idea.title,
        hint: "open",
        group: "Ideas",
        run: () => {
          onNavigate(`#/idea/${idea.id}`);
          onClose();
        },
      });
    }

    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    // Match names *and* keywords, so `h1`, `bold`, `**` and `list` all land.
    return all.filter(
      (c) =>
        c.label.toLowerCase().includes(needle) ||
        (c.keywords ?? []).some((k) => k.toLowerCase().includes(needle)),
    );
  }, [ideas, target, query, createIdea, onNavigate, onClose, openIdea, exportIdea]);

  // Headings are derived rather than stored: one renders only where the group
  // actually changes, so filtering can never leave a heading with nothing under
  // it. Rows stay 1:1 with `commands`, which keeps `index` meaningful.
  const rows = useMemo(() => {
    let current: string | undefined;
    return commands.map((command) => {
      const heading = command.group !== current ? command.group : undefined;
      current = command.group;
      return { command, heading };
    });
  }, [commands]);

  useEffect(() => {
    if (linkEditor) return; // don't steal focus back during the URL step
    inputRef.current?.focus();
  }, [linkEditor]);
  useEffect(() => setIndex(0), [query]);

  const applyLink = () => {
    const href = normalizeHref(query);
    if (linkEditor && href) {
      if (linkEditor.state.selection.empty) {
        // Nothing selected, so a plain `setLink` would be an invisible stored
        // mark: insert the URL as its own link instead.
        linkEditor
          .chain()
          .focus()
          .insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] })
          .run();
      } else {
        linkEditor.chain().focus().extendMarkRange("link").setLink({ href }).run();
      }
    }
    onClose();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (linkEditor) {
      if (e.key === "Enter") {
        e.preventDefault();
        applyLink();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setLinkEditor(null);
        setQuery("");
      }
      return;
    }
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
          placeholder={linkEditor ? "Link URL, then Enter…" : "Search ideas, or insert markdown…"}
          spellCheck={false}
          className="w-full border-b border-border-subtle bg-transparent px-4 py-3 text-base outline-none placeholder:text-text-secondary focus:border-accent"
        />
        <ul className="max-h-80 overflow-y-auto py-1">
          {linkEditor ? (
            <li className="px-4 py-3 text-sm text-text-secondary">
              {linkEditor.state.selection.empty
                ? "Links the URL at the cursor. Esc goes back."
                : "Links the selected text. Esc goes back."}
            </li>
          ) : rows.length === 0 ? (
            <li className="px-4 py-3 text-sm text-text-secondary">Nothing matches.</li>
          ) : (
            rows.map(({ command, heading }, i) => (
              <Fragment key={command.id}>
                {heading && (
                  <li className="px-4 pt-3 pb-1 text-xs tracking-wide text-text-secondary uppercase">
                    {heading}
                  </li>
                )}
                <li>
                  <button
                    type="button"
                    onMouseEnter={() => setIndex(i)}
                    onClick={command.run}
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
                    <span className="truncate">{command.label}</span>
                    <span className={["ml-auto text-xs", i === index ? "text-accent" : ""].join(" ")}>
                      {command.hint}
                    </span>
                  </button>
                </li>
              </Fragment>
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

/**
 * The one-off result panel. It sits opposite the sidebar so it never covers the
 * thing you just acted on, and it stays until dismissed — an export report that
 * vanishes is a report nobody read. Escape and the ✕ both close it.
 */
function NoticePanel() {
  const notice = useStore((s) => s.notice);
  const dismissNotice = useStore((s) => s.dismissNotice);

  useEffect(() => {
    if (!notice) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissNotice();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [notice, dismissNotice]);

  if (!notice) return null;
  const failed = notice.kind === "error";

  return (
    <div
      role={failed ? "alert" : "status"}
      aria-label={notice.title}
      className="fixed right-4 bottom-4 z-[65] w-[24rem] max-w-[92vw] rounded border border-border-subtle bg-surface-raised p-4 shadow-[0_8px_24px_rgb(0_0_0/0.18)]"
    >
      <div className="flex items-start gap-2">
        <span aria-hidden className={failed ? "text-danger" : "text-accent"}>
          {failed ? "!" : "✓"}
        </span>
        <h2 className="text-sm font-semibold">{notice.title}</h2>
        <button
          type="button"
          onClick={dismissNotice}
          aria-label="Dismiss"
          className="ml-auto text-xs text-text-secondary transition-colors duration-[120ms] ease-standard hover:text-text-primary"
        >
          ✕
        </button>
      </div>
      {notice.lines.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs break-words text-text-secondary">
          {notice.lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
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
      // Ctrl+K is plan §29's `Mod+K`: §29 defines `Mod` as Cmd on macOS and Ctrl
      // everywhere else. Excluding Meta enforces that (Meta is never `Mod`), so
      // Super+K stays with the OS palette on this machine.
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
        <CommandPalette
          onClose={() => setPalette(false)}
          onNavigate={navigate}
          openIdea={selected}
        />
      )}
      {themeOpen && <ThemePanel />}
      <ContextMenu />
      <NoticePanel />
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
