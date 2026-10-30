# Codex MCP publishing

Preview exposes a stateless Streamable HTTP endpoint at `https://preview.carlocaprini.com/mcp`. One dedicated Bearer token authenticates both the MCP endpoint and its upload-transfer URLs. Keep the token in an environment variable; never put it in `config.toml`, prompts, logs, or repository files.

Example Codex configuration:

```toml
[mcp_servers.preview]
url = "https://preview.carlocaprini.com/mcp"
env_http_headers = { "Authorization" = "PREVIEW_MCP_AUTHORIZATION" }
```

Set `PREVIEW_MCP_AUTHORIZATION` to `Bearer ` followed by the token. The local sideband helper reads the same raw token from `PREVIEW_MCP_TOKEN`.

The MCP surface preserves the three publishing operations:

- `preview_create_content`
- `preview_upload_version`
- `preview_create_share_link`

It also exposes `preview_list_contents` to discover stable IDs for existing private content. Search is a trimmed, case-insensitive literal title substring and results use bounded keyset pagination:

```json
{ "query": "Kumbe", "limit": 20, "cursor": null }
```

Pass the returned opaque `nextCursor` back with the same query to continue. The tool returns compact metadata only; it does not return stored files or bearer share URLs and does not create analytics activity.

Use `preview_get_content` with a discovered `contentId` to inspect the current publication and PDF state. It reports either `publication.state: "unpublished"` or the single current `ready` version with file count and size, plus link counts and `pdfCompanion.state` (`none`, `current` or `outdated`). It intentionally returns no historical versions, file bytes, detailed analytics or bearer URLs.

Use `preview_get_analytics` for aggregate engagement. `days` is limited to `7`, `30` or `90` (default `30`) and returns exactly that many zero-filled UTC calendar days plus separate all-time totals. An optional internal `linkId` scopes the result to one link belonging to the content. Values represent measured views, visible milliseconds and fully served PDF responses—not identified or unique people.

Use `preview_list_share_links` to recover existing links instead of creating duplicates. It supports `active`, `expired`, `revoked` or `all` states, literal label search and bounded cursor pagination. Returned URLs are bearer capabilities: keep them out of prompts sent to unrelated tools, logs, issues and public output. A label records owner intent; it does not identify or verify a reader.

Use `preview_update_share_link_expiry` with an internal `linkId` and a timezone-aware ISO instant, or explicit `null` for no expiry. It can extend, shorten, immediately expire or restore a non-revoked expired link. Use `preview_revoke_share_link` only for an expressly requested irreversible revocation; retries are idempotent and preserve the first `revokedAt`. Revocation never deletes historical aggregate analytics and cannot be undone by an expiry edit.

Use `preview_get_content_files` to inspect the manifest of the single current active HTML/ZIP version. Each entry contains its relative path, media type, exact size and SHA-256 digest. `preview_read_content_file` returns small UTF-8 text files inline; binary files and text larger than 64 KiB return a `download` instruction instead. Always pass the observed `activeVersionId`: a replacement makes the plan stale instead of mixing versions.

To export the complete current tree, save the manifest result as a JSON transfer plan and run:

```sh
node scripts/preview-transfer.mjs download ./content-transfer-plan.json ./current-content
```

The helper sends `PREVIEW_MCP_TOKEN` only to the configured app origin, verifies every path, byte count and SHA-256 digest, and refuses to overwrite an existing destination. Private source retrieval never uses a public share link, renders uploaded HTML, or creates analytics activity.

## PDF companion lifecycle

`preview_start_pdf_upload` creates a guarded new/replacement upload plan for a `.pdf` file from 1 byte through 10 MiB. Save the plan and transfer the real local bytes with:

```sh
node scripts/preview-transfer.mjs pdf-upload ./analysis.pdf ./pdf-transfer-plan.json
```

The helper validates the local byte count and `%PDF-` signature, uploads with the same MCP Bearer and commits before reporting success. A currently approved PDF remains public until a replacement commit succeeds.

Activating new HTML deliberately makes the retained PDF `outdated` and unavailable to recipients. Use `preview_confirm_pdf_reuse` only after explicitly deciding that the exact `pdfId` is still correct for the exact `expectedActiveVersionId`. Use `preview_remove_pdf` with `expectedPdfId` to detach it; stale removal cannot delete a newer replacement. Removal is destructive for current availability but preserves historical delivery aggregates, while physical orphan chunks remain subject to the existing cleanup grace period.

The first two accept a validated manifest and return short-lived authenticated per-file upload URLs plus a commit URL. A remote Worker cannot dereference a path on the Codex machine, so real file bytes move through the local sideband helper:

```sh
node scripts/preview-transfer.mjs manifest ./experience.zip
node scripts/preview-transfer.mjs upload ./experience.zip ./transfer-plan.json
```

The intended Codex flow is:

1. Run `manifest` locally.
2. Call `preview_create_content` or `preview_upload_version` with that manifest.
3. Save the returned structured transfer plan locally without secrets.
4. Run `upload`; the helper streams each real file and calls commit.
5. Optionally call `preview_create_share_link`.

ZIP extraction happens locally. The server independently validates normalized paths, file types, file counts, byte counts, manifest membership, upload expiry, stored-object metadata, and activation concurrency.
