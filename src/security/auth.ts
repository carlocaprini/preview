import type { PreviewEnv, PreviewExecutionContext } from "../types.ts";

export interface AuthResult {
  authorized: boolean;
  principal?: string;
}

function normalized(value: string): Uint8Array {
  return new TextEncoder().encode(value.trim());
}

export function timingSafeEqual(left: string, right: string): boolean {
  const a = normalized(left);
  const b = normalized(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }

  return difference === 0;
}

export async function authenticateOwner(
  env: PreviewEnv,
  ctx: PreviewExecutionContext,
): Promise<AuthResult> {
  if (!ctx.access) return { authorized: false };

  const identity = await ctx.access.getIdentity();
  const email = identity?.email?.trim().toLowerCase();
  const expected = env.OWNER_EMAIL.trim().toLowerCase();

  if (!email || !expected || !timingSafeEqual(email, expected)) {
    return { authorized: false };
  }

  return { authorized: true, principal: email };
}

export async function authenticateMcp(
  request: Request,
  env: PreviewEnv,
  ctx: PreviewExecutionContext,
): Promise<AuthResult> {
  if (!ctx.access) return { authorized: false };

  const presentedClientId = request.headers.get("cf-access-client-id") ?? "";
  if (
    !presentedClientId ||
    !env.MCP_ACCESS_CLIENT_ID ||
    !timingSafeEqual(presentedClientId, env.MCP_ACCESS_CLIENT_ID)
  ) {
    return { authorized: false };
  }

  return { authorized: true, principal: "mcp-service" };
}
