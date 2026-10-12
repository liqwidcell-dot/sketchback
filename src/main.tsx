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
import {
  useCallback,
  useEffect,
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

const SQL = {
  seedVault: `INSERT OR IGNORE INTO vault (id, name, created_at) VALUES ('local', $1, $2)`,
  seedDevice: `INSERT OR IGNORE INTO device (id, name, created_at) VALUES ($1, $2, $3)`,
  listIdeas: `SELECT id, title, icon, pinned, created_at, updated_at
                FROM idea WHERE deleted_at IS NULL
               ORDER BY pinned DESC, updated_at DESC`,
  insertIdea: `INSERT INTO idea (id, title, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
  renameIdea: `UPDATE idea SET title = $1, updated_at = $2 WHERE id = $3`,
  softDeleteIdea: `UPDATE idea SET deleted_at = $1, updated_at = $1 WHERE id = $2`,
} as const;

const now = () => Date.now();

/* ─────────────────────────────── Store ──────────────────────────────────── */

interface State {
  ready: boolean;
  error: string | null;
  ideas: IdeaRow[];
  vaultRoot: string;
  version: string;
  paletteOpen: boolean;
  setPalette(open: boolean): void;
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

  setPalette: (open) => set({ paletteOpen: open }),

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

    await useStore.getState().refresh();
    useStore.setState({ ready: true, vaultRoot, version });
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

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border-subtle bg-surface-sunken">
      <header className="flex items-center gap-2 px-3 py-3">
        <span className="text-sm font-semibold tracking-wide">Sketchback</span>
        <button
          type="button"
          onClick={onNew}
          title="New idea"
          className="ml-auto rounded border border-border-subtle bg-surface-raised px-2 py-0.5 text-xs text-text-secondary transition-colors duration-[120ms] ease-standard hover:border-accent hover:text-accent"
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
                  <button
                    type="button"
                    onClick={() => onOpen(idea.id)}
                    className={[
                      "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm",
                      "transition-colors duration-[120ms] ease-standard",
                      active
                        ? "bg-surface-raised text-text-primary shadow-[0_4px_12px_rgb(0_0_0/0.08)]"
                        : "text-text-secondary hover:bg-surface-raised hover:text-text-primary",
                    ].join(" ")}
                  >
                    <span>{idea.icon ?? "◇"}</span>
                    <span className="truncate">{idea.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      <footer className="border-t border-border-subtle px-3 py-2 text-xs text-text-secondary">
        <div className="truncate" title={vaultRoot}>
          {vaultRoot || "—"}
        </div>
        <div>v{version || "…"}</div>
      </footer>
    </aside>
  );
}

function IdeaView({ idea }: { idea: IdeaRow }) {
  const renameIdea = useStore((s) => s.renameIdea);
  const deleteIdea = useStore((s) => s.deleteIdea);
  const [draft, setDraft] = useState(idea.title);

  useEffect(() => setDraft(idea.title), [idea.id, idea.title]);

  const commit = () => {
    if (draft.trim() !== idea.title) void renameIdea(idea.id, draft);
  };

  return (
    <article className="mx-auto flex h-full max-w-3xl flex-col px-10 py-8">
      <input
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
          onClick={() => void deleteIdea(idea.id)}
          className="ml-auto transition-colors duration-[120ms] ease-standard hover:text-danger"
        >
          Delete
        </button>
      </div>

      <div className="mt-8 flex-1 rounded border border-dashed border-border-subtle p-6 text-sm text-text-secondary">
        Blocks arrive in week 2 — text, sketch, photo, voice memo, file. This idea is
        the container they will live in.
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
        className="rounded bg-accent px-3 py-1.5 text-sm text-white transition-opacity duration-[120ms] ease-standard hover:opacity-90"
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
          className="w-full border-b border-border-subtle bg-transparent px-4 py-3 text-base outline-none placeholder:text-text-secondary"
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
                    "flex w-full items-center gap-3 px-4 py-2 text-left text-sm",
                    i === index ? "bg-surface-sunken text-text-primary" : "text-text-secondary",
                  ].join(" ")}
                >
                  <span className="truncate">{c.label}</span>
                  <span className="ml-auto text-xs">{c.hint}</span>
                </button>
              </li>
            ))
          )}
        </ul>
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
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
void boot();
