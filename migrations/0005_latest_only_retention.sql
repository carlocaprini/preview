ALTER TABLE content ADD COLUMN next_version_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_version_sequence > 0);

UPDATE content
   SET next_version_sequence = COALESCE(
     (SELECT MAX(cv.sequence) + 1 FROM content_version cv WHERE cv.content_id = content.id),
     1
   );

ALTER TABLE content_version ADD COLUMN purge_after TEXT;

-- Versions that were already superseded before latest-only retention was
-- introduced receive the same grace as a newly superseded version. Active
-- versions and any version still owned by an open upload remain untouched.
UPDATE content_version
   SET purge_after = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+24 hours')
 WHERE status = 'ready'
   AND NOT EXISTS (
     SELECT 1 FROM content c WHERE c.active_version_id = content_version.id
   )
   AND NOT EXISTS (
     SELECT 1 FROM upload_session us
      WHERE us.version_id = content_version.id AND us.state = 'open'
   );

CREATE INDEX IF NOT EXISTS idx_version_purge_after
  ON content_version(purge_after)
  WHERE purge_after IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_upload_expiry_state
  ON upload_session(expires_at, state);
