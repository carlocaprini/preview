# Security policy

Preview is a personal, single-owner project published as a reference
implementation. Security reports are considered on a best-effort basis; there
is no response-time, remediation-time, or support SLA.

## Supported version

Only the current `main` branch and the currently deployed production version
are considered. Older commits, forks, modified deployments, and third-party
infrastructure are not supported versions.

## Report a vulnerability privately

After the repository's public release, use GitHub's **Security → Report a
vulnerability** flow for this repository. It creates a private vulnerability
report visible to the maintainer and must be preferred over an issue,
discussion, pull request, or public comment.

Do not put any of the following in public GitHub content:

- credentials, tokens, cookies, secret values, or database/account IDs;
- live share URLs or owner-preview capabilities;
- customer documents, titles, labels, analytics, or screenshots;
- exploit details that would make an unresolved vulnerability easier to use;
- Cloudflare logs or artifacts containing private operational data.

If GitHub does not show the private reporting flow, do not publish the report.
Use the maintainer contact route linked from the GitHub profile only to request
a private channel, without including vulnerability details or sensitive data.

## What to include

Provide the smallest safe reproduction possible:

- affected route or component, using synthetic identifiers;
- impact and required preconditions;
- repository commit or deployed version when known;
- reproducible steps using synthetic content;
- any suggested mitigation, if available.

Never test against content or accounts you do not own. Do not perform denial of
service, persistence, data extraction, social engineering, or automated scans
against the production deployment.

## Handling expectations

The maintainer may acknowledge, investigate, request a safer reproduction,
decline an out-of-scope report, rotate secrets, revoke links, or temporarily
disable affected functionality. Acknowledgement and remediation are
best-effort. Coordinated disclosure timing must be agreed privately before any
public disclosure.

If a report contains an exposed credential or live bearer URL, assume it is
compromised. The maintainer may rotate or revoke it immediately; the report
itself is not a substitute for rotation.

## Scope boundaries

This policy does not authorize access to Carlo Caprini's accounts, customer
content, Cloudflare infrastructure, or third-party systems. Vulnerabilities in
dependencies should also be reported to their upstream maintainers when the
issue is not specific to Preview.
