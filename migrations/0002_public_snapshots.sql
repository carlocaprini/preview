ALTER TABLE content_version ADD COLUMN public_snapshot_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_version_public_snapshot
  ON content_version(public_snapshot_id)
  WHERE public_snapshot_id IS NOT NULL;
