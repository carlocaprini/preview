# Codex MCP publishing

Preview exposes a stateless Streamable HTTP endpoint at `https://preview.carlocaprini.com/mcp`. Cloudflare Access service-token headers authenticate the client. Keep both values in environment variables; never put them in `config.toml`, prompts, logs, or repository files.

Example Codex configuration:

```toml
[mcp_servers.preview]
url = "https://preview.carlocaprini.com/mcp"
env_http_headers = { "CF-Access-Client-Id" = "CF_ACCESS_CLIENT_ID", "CF-Access-Client-Secret" = "CF_ACCESS_CLIENT_SECRET" }
```

The MCP surface has exactly three business operations:

- `preview_create_content`
- `preview_upload_version`
- `preview_create_share_link`

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
