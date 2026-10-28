import type { PreviewEnv } from "../types.ts";

export interface AuthResult {
  authorized: boolean;
  principal?: string;
}

interface OwnerSessionPayload {
  version: 1;
  expiresAt: number;
  nonce: string;
}

interface OwnerPreviewPayload {
  version: 1;
  contentId: string;
  snapshotId: string;
  expiresAt: number;
}

export const OWNER_SESSION_COOKIE = "__Host-preview_owner";
export const OWNER_SESSION_TTL_SECONDS = 12 * 60 * 60;
export const OWNER_PREVIEW_TTL_SECONDS = 60 * 60;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`;
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

async function hmac(secret: string, purpose: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${purpose}:${payload}`));
  return base64Url(new Uint8Array(signature));
}

function randomToken(bytes = 16): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64Url(value);
}

function encodePayload(payload: object): string {
  return base64Url(encoder.encode(JSON.stringify(payload)));
}

function decodePayload<T>(value: string): T | null {
  try {
    return JSON.parse(decoder.decode(decodeBase64Url(value))) as T;
  } catch {
    return null;
  }
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

async function ownerSessionSignature(payload: string, env: PreviewEnv): Promise<string> {
  const passwordFingerprint = base64Url(await digest(env.OWNER_PASSWORD));
  return hmac(env.SHARE_SIGNING_KEY, "preview-owner-session-v1", `${passwordFingerprint}:${payload}`);
}

export async function verifyOwnerPassword(password: string, env: PreviewEnv): Promise<boolean> {
  if (!password || !env.OWNER_PASSWORD) return false;
  return timingSafeEqual(password, env.OWNER_PASSWORD);
}

export async function createOwnerSession(
  env: PreviewEnv,
  now = new Date(),
  ttlSeconds = OWNER_SESSION_TTL_SECONDS,
): Promise<string> {
  const payload = encodePayload({
    version: 1,
    expiresAt: Math.floor(now.getTime() / 1000) + ttlSeconds,
    nonce: randomToken(),
  } satisfies OwnerSessionPayload);
  return `${payload}.${await ownerSessionSignature(payload, env)}`;
}

export function ownerSessionCookie(token: string, maxAge = OWNER_SESSION_TTL_SECONDS): string {
  return `${OWNER_SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearOwnerSessionCookie(): string {
  return `${OWNER_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export async function authenticateOwner(
  request: Request,
  env: PreviewEnv,
  now = new Date(),
): Promise<AuthResult> {
  const token = cookieValue(request, OWNER_SESSION_COOKIE);
  if (!token) return { authorized: false };
  const [payloadValue, presentedSignature, ...extra] = token.split(".");
  if (!payloadValue || !presentedSignature || extra.length) return { authorized: false };

  const payload = decodePayload<OwnerSessionPayload>(payloadValue);
  if (
    !payload ||
    payload.version !== 1 ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= Math.floor(now.getTime() / 1000) ||
    typeof payload.nonce !== "string"
  ) {
    return { authorized: false };
  }

  const expectedSignature = await ownerSessionSignature(payloadValue, env);
  if (!(await timingSafeEqual(presentedSignature, expectedSignature))) return { authorized: false };
  return { authorized: true, principal: "owner" };
}

export async function authenticateMcp(request: Request, env: PreviewEnv): Promise<AuthResult> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+([^\s]+)$/iu);
  const presented = match?.[1] ?? "";
  if (!presented || !env.MCP_BEARER_TOKEN || !(await timingSafeEqual(presented, env.MCP_BEARER_TOKEN))) {
    return { authorized: false };
  }
  return { authorized: true, principal: "mcp-service" };
}

export function isSameOriginMutation(request: Request, env: PreviewEnv): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return true;
  return request.headers.get("origin") === env.APP_ORIGIN;
}

export async function createOwnerPreviewToken(
  contentId: string,
  snapshotId: string,
  secret: string,
  now = new Date(),
  ttlSeconds = OWNER_PREVIEW_TTL_SECONDS,
): Promise<string> {
  const payload = encodePayload({
    version: 1,
    contentId,
    snapshotId,
    expiresAt: Math.floor(now.getTime() / 1000) + ttlSeconds,
  } satisfies OwnerPreviewPayload);
  return `${payload}.${await hmac(secret, "preview-owner-asset-v1", payload)}`;
}

export async function parseOwnerPreviewToken(
  token: string,
  secret: string,
  now = new Date(),
): Promise<{ contentId: string; snapshotId: string } | null> {
  const [payloadValue, presentedSignature, ...extra] = token.split(".");
  if (!payloadValue || !presentedSignature || extra.length) return null;
  const payload = decodePayload<OwnerPreviewPayload>(payloadValue);
  if (
    !payload ||
    payload.version !== 1 ||
    typeof payload.contentId !== "string" ||
    typeof payload.snapshotId !== "string" ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= Math.floor(now.getTime() / 1000)
  ) {
    return null;
  }
  const expectedSignature = await hmac(secret, "preview-owner-asset-v1", payloadValue);
  if (!(await timingSafeEqual(presentedSignature, expectedSignature))) return null;
  return { contentId: payload.contentId, snapshotId: payload.snapshotId };
}
