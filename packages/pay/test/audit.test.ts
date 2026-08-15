import { describe, expect, it } from "vitest";
import { appendAudit, readAudit } from "../src/audit.js";
import { openDb } from "../src/db.js";

describe("appendAudit redaction", () => {
  it("redacts card material and keys regardless of casing or separators", () => {
    const db = openDb(":memory:");
    appendAudit(db, {
      purchaseId: "p1",
      kind: "TEST",
      detail: {
        spendPrivateKey: "0xsecret",
        cardNumber: "4111111111111111",
        txSignature: "0xsig",
        private_key: "0xalsosecret",
        card_number: "4111111111111111",
        amountCents: 1800,
      },
    });

    const events = readAudit(db, "p1");
    expect(events).toHaveLength(1);
    const detail = events[0]?.detail as Record<string, unknown> | undefined;

    expect(detail?.spendPrivateKey).toBe("[redacted]");
    expect(detail?.cardNumber).toBe("[redacted]");
    expect(detail?.txSignature).toBe("[redacted]");
    expect(detail?.private_key).toBe("[redacted]");
    expect(detail?.card_number).toBe("[redacted]");
    expect(detail?.amountCents).toBe(1800);
  });
});
