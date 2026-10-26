const required = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_D1_DATABASE_ID",
  "OWNER_EMAIL",
  "MCP_ACCESS_CLIENT_ID",
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
console.log("Required deployment configuration is present.");
