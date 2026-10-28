CREATE TABLE IF NOT EXISTS measurement_receipt (
  id TEXT PRIMARY KEY,
  share_link_id TEXT NOT NULL REFERENCES share_link(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_measurement_receipt_expiry ON measurement_receipt(expires_at);
