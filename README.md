# Preview

Preview is Carlo Caprini's lightweight service for publishing externally authored HTML experiences through revocable, expiring bearer links and reviewing privacy-minimizing aggregate engagement.

## Source of truth

GitHub Issues #1–#11 contain the approved product, UX, technical design, feasibility gates, implementation plan, and release criteria. The older [`docs/product-definition.md`](docs/product-definition.md) is retained as historical discovery context and is not authoritative.

## Architecture

- Cloudflare Worker application and API
- Private R2 storage with immutable version prefixes
- D1 metadata and daily aggregate analytics
- Cloudflare Access for the single owner and authenticated MCP client
- Separate application and content origins for untrusted HTML isolation
- Two-screen owner workspace for upload, versioning, sharing, and aggregate review
- Meaningful-view and visible-time aggregates without reader identities

See [`docs/architecture.md`](docs/architecture.md) and [`docs/operations.md`](docs/operations.md).

## Local checks

```sh
npm install
npm run check
npm run test:e2e
```

Use `cf dev` for local Worker development. Production deployment is intentionally restricted to the GitHub Actions workflow triggered by a push to `main` after the owner merges the complete PR stack.

Pull requests run type checks, unit/integration tests, the production build, dependency audit, and responsive Chromium acceptance tests without deploying. A push to `main` repeats those gates, applies D1 migrations, deploys with the Cloudflare CLI, and probes the production security boundaries.
