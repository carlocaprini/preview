ALTER TABLE content ADD COLUMN next_version_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_version_sequence > 0);

UPDATE content
   SET next_version_sequence = COALESCE(
     (SELECT MAX(cv.sequence) + 1 FROM content_version cv WHERE cv.content_id = content.id),
     1
   );

ALTER TABLE content_version ADD COLUMN purge_after TEXT;

CREATE INDEX IF NOT EXISTS idx_version_purge_after
  ON content_version(purge_after)
  WHERE purge_after IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_upload_expiry_state
  ON upload_session(expires_at, state);
