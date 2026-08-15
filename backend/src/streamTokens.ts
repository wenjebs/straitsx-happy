import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Capability URLs for the scout livestream.
 *
 * The stream is loaded by an `<img>`, which cannot carry an Authorization header, so the route
 * cannot sit behind the normal bearer-token middleware. Left open it was an enumeration hole:
 * agent ids are `scout-<itemId>-<slot>` and item ids come from a slugged product name, so guessing
 * another user's stream is a matter of trying "scout-item-1-notebook-0".
 *
 * So the URL itself is the credential — signed, scoped to one agent, and expiring. This is the
 * same shape as the card-grant tokens the purchase path already hands out.
 *
 * The secret defaults to a value generated at boot. That is deliberate for a single-task
 * deployment: tokens die with the process, and a reconnecting client is sent a fresh
 * `activity.snapshot` carrying freshly-minted URLs. Set STREAM_TOKEN_SECRET when more than one
 * instance serves the same activity.
 */
export function defaultStreamSecret(): string {
  return randomBytes(32).toString("hex");
}

export function mintStreamToken(secret: string, agentId: string, ttlSeconds: number): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${expiresAt}.${sign(secret, agentId, expiresAt)}`;
}

export function verifyStreamToken(
  secret: string,
  agentId: string,
  token: string | undefined,
): boolean {
  if (!token) return false;
  const separator = token.indexOf(".");
  if (separator <= 0) return false;
  const expiresAt = Number.parseInt(token.slice(0, separator), 10);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;
  // Signed over the agent id, so a valid token for one tile cannot be replayed against another.
  return safeEqual(token.slice(separator + 1), sign(secret, agentId, expiresAt));
}

function sign(secret: string, agentId: string, expiresAt: number): string {
  return createHmac("sha256", secret).update(`${agentId}.${expiresAt}`).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
