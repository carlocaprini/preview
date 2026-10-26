# Preview V1 architecture

GitHub Issues #1–#11 are the product and delivery source of truth. This document records the implementation that realizes those decisions.

## Security boundary

Preview uses one Worker deployment on two explicit origins:

- `preview.carlocaprini.com` serves the public frame, owner UI, REST API, and MCP endpoint.
- `content.preview.carlocaprini.com` serves uploaded HTML and every local asset from private R2.

The Worker rejects every unconfigured hostname. `workers.dev` and preview URLs are disabled. Cloudflare Access protects `/admin*`, `/api/admin/*`, `/mcp`, and owner-preview routes at the edge, while the Worker independently requires an Access context. The owner identity must match `OWNER_EMAIL`; MCP additionally requires the expected Access service-token client ID. Untrusted HTML is never returned from the privileged origin.

Uploaded assets use immutable keys:

```text
content/{contentId}/versions/{versionId}/{normalizedRelativePath}
```

Every renderer request resolves an authorized link or owner preview, verifies a ready version and manifest membership, and reads through the R2 binding. The R2 bucket has no public endpoint. Gated responses use `no-store` and `Referrer-Policy: no-referrer`.

## Data and activation

D1 holds content metadata, immutable version manifests, upload sessions, asset completeness, share-link state, and daily aggregates. R2 writes happen under a staging version prefix. A version becomes visible only after all declared assets match their manifest and a D1 conditional pointer update marks it ready. R2 upload and D1 cannot form one transaction, so immutable prefixes plus the final metadata pointer are the atomic publication boundary.

Overlapping uploads record the active version observed when staging began. A stale upload cannot overwrite a newer activation. Retrying an already committed session is idempotent.

## Browser isolation

The privileged shell embeds the content origin in a sandboxed iframe without `allow-same-origin`. Uploaded code therefore receives an opaque browser origin and cannot read the parent DOM, Access cookies, or privileged API responses. The content origin receives a narrow CSP, no credentials from the application origin, and no bearer-link referrer propagation.

Already downloaded bytes cannot be revoked from a browser. Revocation and expiry apply to every subsequent HTML or asset request.

## Analytics boundary

V1 stores daily counts of meaningful displayed views, last-view timestamps, and bounded visible-time totals. It stores no raw IP address, fingerprint, cookie identifier, recipient identity, per-session history, click events, or individual timeline. A link label is an owner note, not a verified reader.

The parent can measure its own visibility and iframe load. It cannot truthfully observe arbitrary cross-origin document scroll position without injecting cooperative code. V1 therefore does not report scroll or section depth. This preserves the approved requirement to prefer fewer honest measures over false precision.
