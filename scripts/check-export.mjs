/**
 * Runs the markdown-export logic from `src/main.tsx` under plain Node.
 *
 * Why this exists: the export is the most intricate thing in the app so far —
 * filename sanitising, relative-link rewriting, escaped-wikilink recovery,
 * cycle-guarded traversal — and it is the feature most likely to break
 * silently. `npm run build` does not touch any of it. Rather than wait for
 * Vitest (plan §3 puts it in week 3), this reuses the app's real module: it
 * copies `src/main.tsx`, swaps the webview-only imports for stubs, cuts the
 * boot tail, appends `check-export.cases.js`, and runs it.
 *
 * It is not a test framework and does not pretend to be one. It is the smallest
 * thing that runs the shipped code, and the cases move to Vitest when that
 * lands and `MemoryPlatform` becomes a real seam.
 *
 *   npm run check:export
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SCRATCH = join(ROOT, ".tmp-export-check");

/** Everything above the app's mount point is the module under test. */
const CUT_MARKER =
  "/* ──────────────────────────── App chrome ────────────────────────────────── */";

/**
 * The webview-only edge of the module. Nothing under test uses these, but ESM
 * resolves the whole import graph before running anything.
 */
const STUBS = {
  "stub-sql.js": `export default class Database { static async load() { throw new Error("no db"); } }`,
  "stub-invoke.js": `export const invoke = async () => {};`,
  "stub-dialog.js": `export const open = async () => null;`,
  "stub-path.js": `export const appConfigDir = async () => "/tmp";`,
  "stub-app.js": `export const getVersion = async () => "test";`,
  "stub-reactdom.js": `export const createRoot = () => ({ render() {} });`,
};

/** `from` → `to`, applied to the copied source. Errors if the source moved. */
const REWRITES = [
  ['from "@tauri-apps/plugin-sql"', 'from "./stub-sql.js"'],
  ['from "@tauri-apps/api/core"', 'from "./stub-invoke.js"'],
  ['from "@tauri-apps/plugin-dialog"', 'from "./stub-dialog.js"'],
  ['from "@tauri-apps/api/path"', 'from "./stub-path.js"'],
  ['from "@tauri-apps/api/app"', 'from "./stub-app.js"'],
  ['from "react-dom/client"', 'from "./stub-reactdom.js"'],
  ['import "./styles.css";', ""],
];

let source = readFileSync(join(ROOT, "src/main.tsx"), "utf8");

for (const [from, to] of REWRITES) {
  if (!source.includes(from)) {
    throw new Error(
      `check-export: could not find ${from} in src/main.tsx — update REWRITES in scripts/check-export.mjs`,
    );
  }
  source = source.replace(from, to);
}

const cutAt = source.indexOf(CUT_MARKER);
if (cutAt === -1) {
  throw new Error(
    `check-export: the app-chrome marker is gone from src/main.tsx — update CUT_MARKER in scripts/check-export.mjs`,
  );
}
source = source.slice(0, cutAt);

const cases = readFileSync(join(HERE, "check-export.cases.js"), "utf8");

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
for (const [name, body] of Object.entries(STUBS)) writeFileSync(join(SCRATCH, name), body);
writeFileSync(join(SCRATCH, "main.tsx"), `${source}\n${cases}`);

const esbuild = join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(esbuild)) {
  throw new Error("check-export: esbuild is not installed — run npm install first");
}

console.log(`check-export: running ${cases.split("\n").length} lines of cases against src/main.tsx\n`);
execFileSync(
  esbuild,
  [
    join(SCRATCH, "main.tsx"),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    `--outfile=${join(SCRATCH, "bundle.cjs")}`,
    "--log-level=warning",
  ],
  { cwd: ROOT, stdio: "inherit" },
);
execFileSync(process.execPath, [join(SCRATCH, "bundle.cjs")], { cwd: ROOT, stdio: "inherit" });
