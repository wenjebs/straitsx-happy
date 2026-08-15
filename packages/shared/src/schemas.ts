import { z } from "zod";

/**
 * Wire contracts shared by apps/api, apps/web and the agent-backend teammate.
 *
 * Only the pieces both halves of the repo must agree on live here. The full
 * Mandate / purchase / decision models are owned by DESIGN.md §2.1 and §3.2 —
 * add them below as they land rather than duplicating them per app.
 */

export const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "not a 20-byte hex address");

export const Hex32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "not a 32-byte hex value");

/** SGD cents. Serialised as a string so JSON never sees a lossy Number. */
export const Minor = z.string().regex(/^\d+$/, "minor must be integer cents");

export const CAIP2 = z.string().regex(/^eip155:\d+$/);

export const HealthResponse = z.object({
  ok: z.boolean(),
  issuer: z.enum(["mock", "straitsx"]),
  chainId: z.number().int(),
  /** Non-empty means `decide()` will deny. e.g. ["CHAIN_STALE", "NO_SPEND_KEY"]. */
  blockers: z.array(z.string()),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** Prerendered by the API so the three numbers can never drift. DESIGN.md §2.4. */
export const ActiveMandateFooter = z.object({
  footer: z.string(),
});
export type ActiveMandateFooter = z.infer<typeof ActiveMandateFooter>;
