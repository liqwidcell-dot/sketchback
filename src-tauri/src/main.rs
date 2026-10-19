// Sketchback — the Rust shell.
//
// Deliberately thin. The frontend owns the logic (plan §4); Rust owns the SQLite
// handle and, later, blob IO, hashing, fs watch and mic fallback. For week 1 the
// only real job is the schema: the full DDL from plan §7 as migration v1.

// On Windows, a release build without this is linked as a console program: the
// app runs, but with a stray console window behind it. Checked in the artefact
// itself (PE header subsystem must read "Windows GUI", not "Windows CUI").
// Debug builds keep the console so panics and println! stay visible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::path::{Component, Path, PathBuf};
use tauri_plugin_sql::{Migration, MigrationKind};

/// Plan §7. Two deliberate edits to the plan's listing:
///   - the drafting artifact `CREATE INDEX idx_link_title ON link(vault_unscoped_title)`
///     is dropped; the corrected `to_title COLLATE NOCASE` index is the real one.
///   - PRAGMAs and the FTS5 `search` table are NOT here. `journal_mode` cannot be
///     set inside the migration transaction, and FTS5 may be absent from the
///     bundled driver, so both are applied best-effort from the frontend at boot.
///
/// `IF NOT EXISTS` throughout so re-running is harmless.
const SCHEMA: &str = r#"
-- ─── Vault ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vault (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- ─── Devices ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER
);

-- ─── Ideas ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idea (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT 'Untitled',
  icon        TEXT,
  color       TEXT,
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_idea_updated ON idea(updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_idea_title   ON idea(title COLLATE NOCASE);

-- ─── Blocks ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS block (
  id          TEXT PRIMARY KEY,
  idea_id     TEXT NOT NULL REFERENCES idea(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  order_key   TEXT NOT NULL,
  data_json   TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_block_idea ON block(idea_id, order_key) WHERE deleted_at IS NULL;

-- ─── Links ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS link (
  id           TEXT PRIMARY KEY,
  from_idea_id TEXT NOT NULL REFERENCES idea(id) ON DELETE CASCADE,
  to_idea_id   TEXT REFERENCES idea(id) ON DELETE SET NULL,
  to_title     TEXT NOT NULL,
  block_id     TEXT REFERENCES block(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_link_from  ON link(from_idea_id);
CREATE INDEX IF NOT EXISTS idx_link_to    ON link(to_idea_id) WHERE to_idea_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_link_title ON link(to_title COLLATE NOCASE);

-- ─── Blobs ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blob (
  hash        TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  mime        TEXT NOT NULL,
  ext         TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS block_blob (
  block_id  TEXT NOT NULL REFERENCES block(id) ON DELETE CASCADE,
  blob_hash TEXT NOT NULL REFERENCES blob(hash) ON DELETE RESTRICT,
  role      TEXT NOT NULL,
  PRIMARY KEY (block_id, blob_hash, role)
);
CREATE INDEX IF NOT EXISTS idx_block_blob_hash ON block_blob(blob_hash);

-- ─── Boards ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS board (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  icon       TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS board_column (
  id        TEXT PRIMARY KEY,
  board_id  TEXT NOT NULL REFERENCES board(id) ON DELETE CASCADE,
  title     TEXT NOT NULL,
  order_key TEXT NOT NULL,
  wip_limit INTEGER
);
CREATE INDEX IF NOT EXISTS idx_column_board ON board_column(board_id, order_key);

CREATE TABLE IF NOT EXISTS board_card (
  id         TEXT PRIMARY KEY,
  column_id  TEXT NOT NULL REFERENCES board_column(id) ON DELETE CASCADE,
  idea_id    TEXT NOT NULL REFERENCES idea(id) ON DELETE CASCADE,
  order_key  TEXT NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_column ON board_card(column_id, order_key);
CREATE INDEX IF NOT EXISTS idx_card_idea   ON board_card(idea_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_card_board_idea ON board_card(idea_id) WHERE idea_id IS NOT NULL;

-- ─── Tags ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tag (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS idea_tag (
  idea_id TEXT NOT NULL REFERENCES idea(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (idea_id, tag_id)
);

-- ─── Ops (the append-only log) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS op (
  id           TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL REFERENCES device(id),
  seq          INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  idea_id      TEXT,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  server_seq   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_op_device_seq ON op(device_id, seq);
CREATE INDEX IF NOT EXISTS idx_op_idea   ON op(idea_id, seq);
CREATE INDEX IF NOT EXISTS idx_op_unsent ON op(server_seq) WHERE server_seq IS NULL;

-- ─── Version vectors ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS version (
  idea_id   TEXT NOT NULL,
  device_id TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  PRIMARY KEY (idea_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_version_device ON version(device_id, seq);

-- ─── Unlinked mentions ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mention (
  idea_id     TEXT NOT NULL,
  block_id    TEXT NOT NULL,
  title_lower TEXT NOT NULL,
  PRIMARY KEY (idea_id, block_id, title_lower)
);
CREATE INDEX IF NOT EXISTS idx_mention_title ON mention(title_lower);

-- ─── Settings (key/value) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

/// Plan §28. Note: §7's DDL calls this table `setting`; §28 calls it `prefs`.
/// The spec disagrees with itself — §28 is the preferences spec, so `prefs`
/// wins and `setting` is left in place for later non-preference key/values.
const PREFS: &str = r#"
CREATE TABLE IF NOT EXISTS prefs (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
"#;

/* ─────────────── Export (plan §17: the markdown-folder format) ───────────── */

// The frontend builds the file list; Rust only writes it. Writing here rather
// than through `tauri-plugin-fs` keeps that plugin's scope model out of the
// picture — the destination is a folder the user just picked, and a plain
// `std::fs` write is both correct and easy to reason about.
//
// Every path that arrives is *user-derived*: a sanitised idea title becomes a
// filename. Plan §18 says never interpolate user-supplied names into paths, so
// each one is re-validated here rather than trusted from the frontend.

#[derive(Debug, Deserialize)]
pub struct ExportTextFile {
    /// Path relative to the export root, e.g. `My Idea/My Idea.md`.
    pub path: String,
    pub contents: String,
}

#[derive(Debug, Deserialize)]
pub struct ExportBlobCopy {
    /// Path relative to the export root, e.g. `My Idea/attachments/kitchen.png`.
    pub path: String,
    /// Absolute path of the blob on this machine. Rust does the copying, so a
    /// multi-megabyte photo never crosses the IPC boundary.
    pub source: String,
}

/// Join `rel` onto `root`, refusing anything that could write outside `root`.
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err(format!("refusing absolute export path: {rel}"));
    }
    let mut out = root.to_path_buf();
    for component in rel_path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            // `a/./b` is harmless; anything else (`..`, a root or Windows
            // prefix) is refused rather than quietly cleaned, because a cleaned
            // path is how traversal bugs hide.
            Component::CurDir => {}
            _ => {
                return Err(format!(
                    "refusing export path that escapes the destination folder: {rel}"
                ))
            }
        }
    }
    if out == root {
        return Err(format!("refusing to write the destination itself: {rel}"));
    }
    Ok(out)
}

/// The whole write, as a plain function so it can be tested without a webview.
fn write_tree(root: &Path, files: &[ExportTextFile], blobs: &[ExportBlobCopy]) -> Result<(), String> {
    if !root.is_dir() {
        return Err(format!("not a folder: {}", root.display()));
    }

    for file in files {
        let full = safe_join(root, &file.path)?;
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }
        std::fs::write(&full, file.contents.as_bytes())
            .map_err(|e| format!("could not write {}: {e}", full.display()))?;
    }

    for blob in blobs {
        let target = safe_join(root, &blob.path)?;
        let source = Path::new(&blob.source);
        if !source.is_file() {
            return Err(format!("missing source file: {}", source.display()));
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }
        std::fs::copy(source, &target)
            .map_err(|e| format!("could not copy {}: {e}", target.display()))?;
    }

    Ok(())
}

/// Write an exported idea — its markdown files plus any blobs — into `dest`.
///
/// `async` so the write happens off the main thread; the untouched UI matters
/// on the day an idea carries twenty photos (plan §17).
#[tauri::command]
async fn export_write_tree(
    dest: String,
    files: Vec<ExportTextFile>,
    blobs: Vec<ExportBlobCopy>,
) -> Result<(), String> {
    write_tree(Path::new(&dest), &files, &blobs)
}

fn main() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "initial_schema",
            sql: SCHEMA,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "prefs",
            sql: PREFS,
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        // The native folder picker for export (plan §4's `dialog` capability).
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                // The key must match the connection string the frontend loads.
                .add_migrations("sqlite:sketchback.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![export_write_tree])
        .run(tauri::generate_context!())
        .expect("error while running sketchback");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sketchback-export-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn text(path: &str, contents: &str) -> ExportTextFile {
        ExportTextFile {
            path: path.to_string(),
            contents: contents.to_string(),
        }
    }

    #[test]
    fn writes_nested_files_and_their_folders() {
        let root = scratch("nested");
        write_tree(
            &root,
            &[
                text("My Idea/My Idea.md", "# Hello\n"),
                text("My Idea/Second.md", "world\n"),
            ],
            &[],
        )
        .expect("write");

        assert_eq!(
            std::fs::read_to_string(root.join("My Idea/My Idea.md")).unwrap(),
            "# Hello\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("My Idea/Second.md")).unwrap(),
            "world\n"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn copies_blobs_into_the_export() {
        let root = scratch("blobs");
        let source = root.join("source.bin");
        std::fs::write(&source, b"\x00\x01\x02raw bytes").unwrap();

        write_tree(
            &root,
            &[text("Idea/Idea.md", "body")],
            &[ExportBlobCopy {
                path: "Idea/attachments/photo.png".into(),
                source: source.display().to_string(),
            }],
        )
        .expect("write");

        // Byte-for-byte, not text-decoded: a blob is binary.
        assert_eq!(
            std::fs::read(root.join("Idea/attachments/photo.png")).unwrap(),
            b"\x00\x01\x02raw bytes"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn refuses_to_escape_the_destination() {
        let root = scratch("escape");
        for bad in [
            "../outside.md",
            "Idea/../../outside.md",
            "/etc/passwd",
            "..",
        ] {
            let err = write_tree(&root, &[text(bad, "x")], &[]);
            assert!(err.is_err(), "{bad} should have been refused");
        }
        // Nothing leaked above the root.
        assert!(!root.join("..").join("outside.md").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn refuses_a_missing_blob_source() {
        let root = scratch("missing");
        let err = write_tree(
            &root,
            &[],
            &[ExportBlobCopy {
                path: "Idea/attachments/gone.png".into(),
                source: root.join("nope.png").display().to_string(),
            }],
        );
        assert!(err.is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn safe_join_accepts_ordinary_relative_paths() {
        let root = Path::new("/tmp/root");
        assert_eq!(
            safe_join(root, "a/b.md").unwrap(),
            PathBuf::from("/tmp/root/a/b.md")
        );
        // `.` segments are dropped, not treated as an escape.
        assert_eq!(
            safe_join(root, "a/./b.md").unwrap(),
            PathBuf::from("/tmp/root/a/b.md")
        );
    }
}
