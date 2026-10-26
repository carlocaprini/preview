PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS content (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  active_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_version (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  status TEXT NOT NULL CHECK (status IN ('staging', 'ready', 'failed')),
  source_format TEXT NOT NULL CHECK (source_format IN ('html', 'zip')),
  manifest_json TEXT NOT NULL,
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  UNIQUE (content_id, sequence)
);

CREATE TABLE IF NOT EXISTS upload_session (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL UNIQUE REFERENCES content_version(id) ON DELETE CASCADE,
  expected_active_version_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'committed', 'failed', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  committed_at TEXT
);

CREATE TABLE IF NOT EXISTS version_asset (
  version_id TEXT NOT NULL REFERENCES content_version(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  media_type TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL CHECK (expected_bytes >= 0),
  uploaded_bytes INTEGER CHECK (uploaded_bytes >= 0),
  etag TEXT,
  uploaded_at TEXT,
  PRIMARY KEY (version_id, path)
);

CREATE TABLE IF NOT EXISTS share_link (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS daily_aggregate (
  share_link_id TEXT NOT NULL REFERENCES share_link(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  meaningful_views INTEGER NOT NULL DEFAULT 0 CHECK (meaningful_views >= 0),
  active_visible_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_visible_ms >= 0),
  last_view_at TEXT,
  PRIMARY KEY (share_link_id, day)
);

CREATE INDEX IF NOT EXISTS idx_content_updated ON content(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_version_content ON content_version(content_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_link_content ON share_link(content_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aggregate_day ON daily_aggregate(day);
