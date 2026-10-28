import { timingSafeEqual } from "../security/auth.ts";
import { MAX_LINK_LIFETIME_SECONDS, MIN_LINK_LIFETIME_SECONDS } from "./limits.ts";
import { randomId } from "./ids.ts";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function signature(id: string, secret: string): Promise<string> {
  if (new TextEncoder().encode(secret).byteLength < 32) throw new Error("Share signing key is too short");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id));
  return base64Url(new Uint8Array(signed).slice(0, 16));
}

export async function createShareToken(secret: string): Promise<{ id: string; token: string }> {
  const id = randomId(16);
  return { id, token: await shareTokenForId(id, secret) };
}

export async function shareTokenForId(id: string, secret: string): Promise<string> {
  return `${id}.${await signature(id, secret)}`;
}

export async function parseShareToken(token: string, secret: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [id, presented] = parts;
  if (!id || !presented || !/^[A-Za-z0-9_-]{22}$/u.test(id)) return null;
  const expected = await signature(id, secret);
  return (await timingSafeEqual(presented, expected)) ? id : null;
}

export function resolveExpiry(createdAt: Date, validForSeconds: number | null): string | null {
  if (validForSeconds === null) return null;
  if (
    !Number.isSafeInteger(validForSeconds) ||
    validForSeconds < MIN_LINK_LIFETIME_SECONDS ||
    validForSeconds > MAX_LINK_LIFETIME_SECONDS
  ) {
    throw new Error("Link lifetime must be between 60 seconds and 365 days");
  }
  return new Date(createdAt.getTime() + validForSeconds * 1000).toISOString();
}
