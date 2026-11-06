# Preview architecture

GitHub Issues #1–#11 record the original product and delivery decisions. This
document describes the current implementation; issue #25 owns the public-source
release contract.

## Reusable design and deployed instance

The two-origin Worker/D1 design is reusable. The hostnames, Worker and database
names, personal-site referrals, credentials, GitHub environment, and production
verification defaults in this repository describe Carlo Caprini's deployed
instance. An independent fork must replace those values and preserve the
isolation contract; it must not reuse Carlo's credentials or imply endorsement.

## Security boundary

Preview uses one Worker deployment on two explicit origins:

- `preview.carlocaprini.com` serves the public frame, owner UI, REST API, and MCP endpoint.
- `content.preview.carlocaprini.com` serves uploaded HTML and every local asset from D1-backed version storage.

The Worker rejects every unconfigured hostname. `workers.dev` and preview URLs are disabled. Owner authentication is implemented inside the Worker: a high-entropy `OWNER_PASSWORD` creates a signed, 12-hour, host-only `Secure` and `HttpOnly` session cookie. State-changing owner requests must also have the exact application origin. MCP uses a separate high-entropy Bearer token and is accepted only by `/mcp` and the upload-transfer routes it needs. Untrusted HTML is never returned from the privileged origin.

Uploaded assets use immutable version-scoped identities:

```text
(version_id, normalized_relative_path, chunk_index)
```

Every renderer request resolves an authorized link or owner preview, verifies a ready version and manifest membership, and reads the corresponding D1 payload. Gated responses use `no-store` and `Referrer-Policy: no-referrer`.

## Data and activation

D1 holds content metadata, version manifests, upload sessions, asset payloads, share-link state, and daily aggregates. Each asset is split into ordered 512 KiB BLOB rows so every row stays well below D1's per-value limit. A payload row records the total byte count, chunk count, and SHA-256 entity tag; payload metadata and all chunks are replaced atomically in one D1 batch while the upload is open.

A version becomes visible only after every declared asset matches both its manifest record and stored D1 payload, followed by a conditional pointer update that marks the version ready. Activated versions cannot be uploaded again through the application, so their payloads are immutable. The complete D1 database is the transactional and backup boundary; there is no external object-store subscription or binding.

Overlapping uploads record the active version observed when staging began. A stale upload cannot overwrite a newer activation. Retrying an already committed session is idempotent. Each content row allocates an internal monotonic generation number, so removing old version rows can never cause generation reuse.

Preview is latest-only durable storage, not a version archive. When a replacement activates, the prior ready snapshot receives a 24-hour technical grace deadline. During that window an already-open iframe can continue requesting matching assets, while new navigations use the new snapshot. Public asset authorization enforces that deadline even if physical cleanup is delayed. The retention migration gives ready versions that were already superseded at rollout the same 24-hour grace without touching the active version or open uploads. An hourly scheduled cleanup deletes expired superseded version rows and their D1 payload/chunk rows in bounded batches. It also removes failed or abandoned staging versions after their upload TTL. Activation requires the staging row to exist in the same transactional batch that changes the active pointer, so cleanup winning a race cannot leave a dangling active version. The guarded delete can never remove the active version, and share links plus `daily_aggregate` rows are not version-owned, so cumulative analytics survive cleanup. SQLite/D1 can reuse deleted pages; row deletion does not claim an immediate reduction in the reported database file size.

An optional PDF companion uses a separate immutable D1 metadata/chunk store rather than pretending to be an HTML version. One content row may point to one ready companion and separately records the HTML version that approved it. Activating a new HTML version clears that approval in the same conditional pointer update, while retaining the private PDF for explicit owner reuse or replacement. Public download authorization rechecks the live share link, current HTML version, approval pointer, PDF readiness, and chunk integrity on every request.

## Browser isolation

The privileged shell embeds a separately hosted content origin in a sandboxed iframe. `allow-same-origin` lets a package use its own storage and same-origin asset requests, but the distinct content hostname still prevents it from reading the parent DOM, the host-only owner cookie, or privileged API responses. Owner previews receive a signed, one-hour capability URL instead of a cookie. Top navigation is not permitted. The content origin receives a narrow CSP, no credentials from the application origin, and no bearer-link referrer propagation.

Each ready version receives an opaque public snapshot identifier. A new shell navigation resolves a stable bearer link to the current ready snapshot; an already-open shell keeps its pinned snapshot during the bounded grace window so HTML, CSS, JavaScript, and media cannot mix versions. Expiry, revocation, and the superseded-version grace deadline are rechecked for every asset request, including a prior pinned snapshot. Once the deadline passes, that historical snapshot is no longer retrievable even before its rows are physically reclaimed.

Already downloaded bytes cannot be revoked from a browser. Revocation and expiry apply to every subsequent HTML or asset request.

## Analytics boundary

V1 stores daily counts of meaningful displayed views, last-view timestamps, and bounded visible-time totals. A meaningful view requires the iframe to load and remain in a visible parent document for two seconds, so passive URL scanners do not count. Visible time is reported in bounded chunks only while the parent document is visible.

The trusted application-origin shell sends measurement requests with same-origin credentials. On every event the Worker verifies the existing signed owner session; a valid owner session may use the public link normally but produces no measurement receipt, daily aggregate update, or last-view timestamp. Missing, expired, or forged sessions retain the ordinary anonymous measurement behavior. This exclusion identifies only a valid authenticated browser session, not the owner's identity outside that session.

It also stores aggregate completed PDF deliveries and the last delivery timestamp per link/day when a companion is enabled. A PDF delivery is recorded only after its entire bounded D1 stream completes; cancellation, `HEAD`, authorization failure, and storage failure do not count. Repeated successful deliveries count repeatedly and do not claim a unique person or a saved/opened file. Authenticated owner downloads are served normally but excluded from recipient aggregates.

It stores no raw IP address, fingerprint, cookie identifier, recipient identity, per-session history, click events, or individual timeline. Random measurement receipts are kept for at most 24 hours solely to make retries idempotent; they contain no identity or event metadata and are deleted opportunistically. A link label is an owner note, not a verified reader.

The parent can measure its own visibility and iframe load. It cannot truthfully observe arbitrary cross-origin document scroll position without injecting cooperative code. V1 therefore does not report scroll or section depth. This preserves the approved requirement to prefer fewer honest measures over false precision.
