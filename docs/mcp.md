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
