import { describe, expect, it } from "vitest";
import { appendAudit } from "../src/audit.js";
import { openDb } from "../src/db.js";

describe("db", () => {
  it("creates every table", () => {
    const db = openDb(":memory:");
    const names = db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all()
      .map((r: any) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(["mandates", "purchases", "cards", "payments", "audit_events"]),
    );
  });

  it("rolls back the whole transaction on throw", () => {
    const db = openDb(":memory:");
    expect(() =>
      db.tx((t) => {
        appendAudit(t, { kind: "TEST", detail: {} });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const n = db.raw.prepare(`SELECT count(*) c FROM audit_events`).get() as any;
    expect(n.c).toBe(0);
  });

  it("enforces one payment per purchase", () => {
    const db = openDb(":memory:");
    db.raw.exec(`
      INSERT INTO mandates VALUES ('m1',2500,15000,'[]','2030-01-01','ACTIVE','2026-01-01');
      INSERT INTO purchases VALUES ('p1','m1','x','h',null,1800,null,'RESERVED',0,null,'2030-01-01','2026-01-01','2026-01-01');
      INSERT INTO payments VALUES ('0xaa','p1',1800,'2030-01-01','{}','PENDING',null,'2026-01-01');
    `);
    expect(() =>
      db.raw.exec(
        `INSERT INTO payments VALUES ('0xbb','p1',1800,'2030-01-01','{}','PENDING',null,'2026-01-01')`,
      ),
    ).toThrow(/UNIQUE/);
  });
});
