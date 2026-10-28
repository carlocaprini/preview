CREATE TABLE IF NOT EXISTS asset_payload (
  version_id TEXT NOT NULL,
  path TEXT NOT NULL,
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
  etag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (version_id, path),
  FOREIGN KEY (version_id, path) REFERENCES version_asset(version_id, path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS asset_chunk (
  version_id TEXT NOT NULL,
  path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  bytes BLOB NOT NULL,
  PRIMARY KEY (version_id, path, chunk_index),
  FOREIGN KEY (version_id, path) REFERENCES asset_payload(version_id, path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_asset_chunk_payload ON asset_chunk(version_id, path, chunk_index);
