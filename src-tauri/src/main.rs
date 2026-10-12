// Sketchback — the Rust shell.
//
// Deliberately thin. The frontend owns the logic (plan §4); Rust owns the SQLite
// handle and, later, blob IO, hashing, fs watch and mic fallback. For week 1 the
// only real job is the schema: the full DDL from plan §7 as migration v1.

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

fn main() {
    let migrations = vec![Migration {
        version: 1,
        description: "initial_schema",
        sql: SCHEMA,
        kind: MigrationKind::Up,
    }];

    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                // The key must match the connection string the frontend loads.
                .add_migrations("sqlite:sketchback.db", migrations)
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running sketchback");
}
