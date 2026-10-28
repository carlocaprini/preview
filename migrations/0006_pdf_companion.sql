ALTER TABLE content ADD COLUMN current_pdf_id TEXT;
ALTER TABLE content ADD COLUMN pdf_approved_html_version_id TEXT;

CREATE TABLE IF NOT EXISTS pdf_companion (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  safe_filename TEXT NOT NULL CHECK (length(safe_filename) BETWEEN 5 AND 180),
  total_bytes INTEGER NOT NULL CHECK (total_bytes > 0 AND total_bytes <= 10485760),
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('staging', 'ready', 'failed')),
  created_at TEXT NOT NULL,
  ready_at TEXT
);

CREATE TABLE IF NOT EXISTS pdf_companion_chunk (
  pdf_id TEXT NOT NULL REFERENCES pdf_companion(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  bytes BLOB NOT NULL,
  PRIMARY KEY (pdf_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS pdf_upload_session (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  pdf_id TEXT NOT NULL UNIQUE REFERENCES pdf_companion(id) ON DELETE CASCADE,
  expected_active_version_id TEXT NOT NULL,
  expected_current_pdf_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'uploaded', 'committed', 'failed', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  committed_at TEXT
);

ALTER TABLE daily_aggregate ADD COLUMN pdf_downloads_served INTEGER NOT NULL DEFAULT 0 CHECK (pdf_downloads_served >= 0);
ALTER TABLE daily_aggregate ADD COLUMN last_pdf_download_at TEXT;

CREATE INDEX IF NOT EXISTS idx_pdf_content ON pdf_companion(content_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pdf_chunk ON pdf_companion_chunk(pdf_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_pdf_upload_expiry ON pdf_upload_session(expires_at);
