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
        card_number: "4111111111111111",
        txSignature: "0xsig",
        private_key: "0xalsosecret",
        PAN: "4111111111111111",
        cvv: "123",
        cvc: "123",
        accountNumber: "0011223344",
        amountCents: 1800,
      },
    });

    const events = readAudit(db, "p1");
    expect(events).toHaveLength(1);
    const detail = events[0]?.detail as Record<string, unknown> | undefined;

    expect(detail?.spendPrivateKey).toBe("[redacted]");
    expect(detail?.cardNumber).toBe("[redacted]");
    expect(detail?.card_number).toBe("[redacted]");
    expect(detail?.txSignature).toBe("[redacted]");
    expect(detail?.private_key).toBe("[redacted]");
    expect(detail?.PAN).toBe("[redacted]");
    expect(detail?.cvv).toBe("[redacted]");
    expect(detail?.cvc).toBe("[redacted]");
    expect(detail?.accountNumber).toBe("[redacted]");
    expect(detail?.amountCents).toBe(1800);
  });

  it("does not redact ordinary keys that merely contain forbidden substrings", () => {
    const db = openDb(":memory:");
    appendAudit(db, {
      purchaseId: "p2",
      kind: "TEST",
      detail: {
        merchantHost: "shop.example.com",
        orderRef: "abc123",
        companyName: "Acme Pte Ltd",
        panel: "control",
        expansion: "none",
        japan: "region",
        span: "1-2",
        panda: "mascot",
        japanese: "language",
        // a bare "number" with no card-ish word in front is an ordinary field
        orderNumber: "ORD-1",
        phoneNumber: "+6591234567",
      },
    });

    const events = readAudit(db, "p2");
    const detail = events[0]?.detail as Record<string, unknown> | undefined;

    expect(detail?.merchantHost).toBe("shop.example.com");
    expect(detail?.orderRef).toBe("abc123");
    expect(detail?.companyName).toBe("Acme Pte Ltd");
    expect(detail?.panel).toBe("control");
    expect(detail?.expansion).toBe("none");
    expect(detail?.japan).toBe("region");
    expect(detail?.span).toBe("1-2");
    expect(detail?.panda).toBe("mascot");
    expect(detail?.japanese).toBe("language");
    expect(detail?.orderNumber).toBe("ORD-1");
    expect(detail?.phoneNumber).toBe("+6591234567");
  });

  it("redacts separator-less SCREAMINGCASE compounds the tokenizer can't split", () => {
    const db = openDb(":memory:");
    appendAudit(db, {
      purchaseId: "p4",
      kind: "TEST",
      detail: {
        CARDNUMBER: "4111111111111111",
        PRIVATEKEY: "0xsecret",
        TXSIGNATURE: "0xsig",
        CVVCODE: "123",
        ACCOUNTNUMBER: "0011223344",
        apiKey: "sk-live-abc123",
        API_KEY: "sk-live-abc123",
      },
    });

    const events = readAudit(db, "p4");
    const detail = events[0]?.detail as Record<string, unknown> | undefined;

    expect(detail?.CARDNUMBER).toBe("[redacted]");
    expect(detail?.PRIVATEKEY).toBe("[redacted]");
    expect(detail?.TXSIGNATURE).toBe("[redacted]");
    expect(detail?.CVVCODE).toBe("[redacted]");
    expect(detail?.ACCOUNTNUMBER).toBe("[redacted]");
    expect(detail?.apiKey).toBe("[redacted]");
    expect(detail?.API_KEY).toBe("[redacted]");
  });

  it("redacts forbidden keys nested inside the detail object", () => {
    const db = openDb(":memory:");
    appendAudit(db, {
      purchaseId: "p3",
      kind: "TEST",
      detail: {
        payment: {
          cardNumber: "4111111111111111",
          merchantHost: "shop.example.com",
        },
      },
    });

    const events = readAudit(db, "p3");
    const detail = events[0]?.detail as { payment?: Record<string, unknown> } | undefined;

    expect(detail?.payment?.cardNumber).toBe("[redacted]");
    expect(detail?.payment?.merchantHost).toBe("shop.example.com");
  });
});
