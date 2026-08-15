import { describe, expect, it } from "vitest";
import {
  buildAuthorization,
  buildEnvelope,
  newNonce,
  parseChallenge,
  validateChallenge,
} from "../src/x402/client.js";

const RUN = process.env.RUN_LIVE_CONTRACT_TEST === "1";
const BASE = process.env.CARD_API_BASE ?? "https://card.straitsx.ai/sandbox/cardapi";

describe.skipIf(!RUN)("live envelope contract", () => {
  it("is parsed by the server (rejected on signature, not on shape)", async () => {
    const body = JSON.stringify({ amount_sgd: 5, cardholder_name: "Test Agent" });
    const probe = await fetch(`${BASE}/issue_card`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(probe.status).toBe(402);
    const entry = parseChallenge(probe, await probe.text());
    validateChallenge(
      entry,
      {
        allowedNetwork: process.env.ALLOWED_NETWORK!,
        xsgdAddress: process.env.XSGD_ADDRESS! as `0x${string}`,
      },
      500,
    );

    const auth = buildAuthorization(
      entry,
      "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
      newNonce(),
    );
    const envelope = buildEnvelope(entry, `0x${"11".repeat(65)}`, auth);

    const paid = await fetch(`${BASE}/issue_card`, {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": envelope },
      body,
    });
    const text = await paid.text();
    expect(text).toContain("Invalid signature");
    expect(text).not.toContain("cannot parse payment amount");
  }, 30_000);
});
