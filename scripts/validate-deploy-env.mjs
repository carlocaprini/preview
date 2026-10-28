const required = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_D1_DATABASE_ID",
  "OWNER_PASSWORD",
  "MCP_BEARER_TOKEN",
  "SHARE_SIGNING_KEY",
];

const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  console.error(`Missing required deployment values: ${missing.join(", ")}`);
  process.exit(1);
}
if (new TextEncoder().encode(process.env.SHARE_SIGNING_KEY).byteLength < 32) {
  console.error("SHARE_SIGNING_KEY must contain at least 32 bytes.");
  process.exit(1);
}
if (new TextEncoder().encode(process.env.OWNER_PASSWORD).byteLength < 24) {
  console.error("OWNER_PASSWORD must contain at least 24 bytes.");
  process.exit(1);
}
if (!/^[A-Za-z0-9._~-]{32,}$/u.test(process.env.MCP_BEARER_TOKEN)) {
  console.error("MCP_BEARER_TOKEN must contain at least 32 URL-safe characters.");
  process.exit(1);
}
console.log("Required deployment configuration is present.");
