import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { createJobStore } from "../src/service/jobs.js";
import { createLiveView } from "../src/service/liveview.js";
import { type RunDeps, runPurchase } from "../src/service/run.js";
import type { PurchaseJobInput } from "../src/service/verify.js";

const PAN = "4242424242424242";
const CVC = "123";

const jobInput = (): PurchaseJobInput => ({
  activityId: "act_1",
  attemptId: "attempt_1",
  item: { id: "item-1", name: "Coffee" },
  listing: {
    url: "https://merchant.test/p/1",
    title: "Coffee",
    seller: "Merchant",
    price: "S$23.50",
    amountMinor: 2350,
  },
  cardGrant: {
    claimUrl: "https://happy.test/claim",
    token: "grant",
    amountMinor: 2350,
    currency: "SGD",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  },
  sandbox: true,
  idempotencyKey: "k1",
  amountMinor: 2350,
  callback: { url: "https://happy.test/events", token: "cb" },
});

type Posted = Record<string, unknown>;

function harness(
  over: Partial<RunDeps> = {},
  totalMinor = 2350,
  orderRef: string | null = "ORD-9",
) {
  const posted: Posted[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/claim")) {
      return new Response(
        JSON.stringify({
          cardId: "c1",
          last4: "4242",
          agentAccess: { revealUrl: "https://happy.test/reveal", token: "one-use" },
        }),
        { status: 200 },
      );
    }
    if (u.includes("/reveal")) {
      return new Response(
        JSON.stringify({ pan: PAN, expiryMonth: "12", expiryYear: "40", cvc: CVC }),
        { status: 200 },
      );
    }
    posted.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const page = { url: () => "https://merchant.test/p/1" } as unknown as Page;
  const deps: RunDeps = {
    jobs: createJobStore(),
    view: createLiveView(),
    browserFor: async () => ({ newPage: async () => page }),
    fetchImpl,
    liveUrlFor: (id) => `http://127.0.0.1:4042/v1/live/${id}`,
    fillCard: async () => {},
    readTotalMinor: async () => totalMinor,
    submit: async () => orderRef,
    log: () => {},
    ...over,
  };
  return { deps, posted };
}

const types = (posted: Posted[]) => posted.map((p) => p.type);

describe("purchase run", () => {
  it("emits the full happy-path sequence with a live view url", async () => {
    const { deps, posted } = harness();
    deps.jobs.accept(jobInput());
    await runPurchase(deps, jobInput());

    expect(types(posted)).toEqual([
      "browser.started",
      "checkout.prepared",
      "order.placing",
      "order.confirmed",
    ]);
    expect(posted.at(-1)?.orderId).toBe("ORD-9");
    expect(String(posted[0]?.liveStreamUrl)).toContain("attempt_1");
  });

  it("never claims a card when the payload fails verification", async () => {
    const { deps, posted } = harness();
    const bad = jobInput();
    bad.cardGrant.currency = "USD";
    deps.jobs.accept(bad);
    await runPurchase(deps, bad);

    expect(types(posted)).toContain("purchase.failed");
    expect(deps.jobs.get("k1")?.cardClaimed).toBe(false);
  });

  // The merchant nudging its price past the approved amount must cost nothing.
  it("fails without claiming when the merchant total exceeds the approved amount", async () => {
    const { deps, posted } = harness({}, 2400);
    deps.jobs.accept(jobInput());
    await runPurchase(deps, jobInput());

    expect(posted.at(-1)?.type).toBe("purchase.failed");
    expect(String(posted.at(-1)?.message)).toMatch(/exceeds/i);
    expect(deps.jobs.get("k1")?.cardClaimed).toBe(false);
  });

  it("reports failure, never success, when the order reference is unknown", async () => {
    const { deps, posted } = harness({}, 2350, null);
    deps.jobs.accept(jobInput());
    await runPurchase(deps, jobInput());

    expect(types(posted)).not.toContain("order.confirmed");
    expect(posted.at(-1)?.type).toBe("purchase.failed");
  });

  it("blanks the live view while the card is being typed, and resumes after", async () => {
    const blankedDuringFill: boolean[] = [];
    const { deps } = harness();
    deps.fillCard = async () => {
      blankedDuringFill.push(deps.view.isBlanked("attempt_1"));
    };
    deps.jobs.accept(jobInput());
    await runPurchase(deps, jobInput());

    expect(blankedDuringFill).toEqual([true]);
    expect(deps.view.isBlanked("attempt_1")).toBe(false);
  });

  it("never puts card material into any callback", async () => {
    const { deps, posted } = harness();
    deps.jobs.accept(jobInput());
    await runPurchase(deps, jobInput());

    const blob = JSON.stringify(posted);
    expect(blob).not.toContain(PAN);
    expect(blob).not.toContain(`"${CVC}"`);
  });

  it("aborts before claiming once the attempt is cancelled", async () => {
    const { deps, posted } = harness();
    deps.readTotalMinor = async () => {
      deps.jobs.cancel("act_1", "attempt_1");
      return 2350;
    };
    deps.jobs.accept(jobInput());
    await runPurchase(deps, jobInput());

    expect(types(posted)).not.toContain("order.confirmed");
    expect(deps.jobs.get("k1")?.cardClaimed).toBe(false);
    expect(posted.at(-1)?.retryable).toBe(false);
  });

  it("refuses a second run that would claim the same attempt's card again", async () => {
    const { deps, posted } = harness();
    deps.jobs.accept(jobInput());
    await runPurchase(deps, jobInput());
    const after = posted.length;
    await runPurchase(deps, jobInput());

    expect(posted.slice(after).at(-1)?.type).toBe("purchase.failed");
    expect(String(posted.slice(after).at(-1)?.message)).toMatch(/already claimed/i);
  });

  /*
   * An AgentCore session bills until it is stopped and its TTL is half an hour, so a run that
   * forgets to release its browser leaks money on every attempt — including every fast failure.
   * Three dead runs left three sessions billing before this was noticed in the AWS console, which
   * is not a safety net.
   */
  it("releases the browser on success", async () => {
    const released: unknown[] = [];
    const { deps } = harness();
    deps.releaseBrowser = async (b) => {
      released.push(b);
    };
    deps.jobs.accept(jobInput());
    await runPurchase(deps, jobInput());
    expect(released).toHaveLength(1);
  });

  it("releases the browser even when the run fails", async () => {
    const released: unknown[] = [];
    const { deps } = harness({}, 9999); // merchant total over the approved amount
    deps.releaseBrowser = async (b) => {
      released.push(b);
    };
    deps.jobs.accept(jobInput());
    await runPurchase(deps, jobInput());
    expect(released).toHaveLength(1);
  });

  /*
   * The last line of defence. Everything between opening the listing and typing the card can
   * navigate — a model choosing links, a merchant redirect, a page that rewrites itself. Landing
   * somewhere else and typing anyway hands a real card to whoever is on the other end.
   */
  it("refuses to type the card if the page has left the approved merchant", async () => {
    const { deps, posted } = harness();
    let filled = false;
    const strayPage = { url: () => "https://evilmerchant.test/checkout" } as unknown as Page;
    deps.browserFor = async () => ({ newPage: async () => strayPage });
    deps.fillCard = async () => {
      filled = true;
    };
    deps.jobs.accept(jobInput());
    await runPurchase(deps, jobInput());

    expect(filled).toBe(false);
    expect(posted.at(-1)?.type).toBe("purchase.failed");
    expect(String(posted.at(-1)?.message)).toMatch(/refusing to enter card details/i);
  });

  it("calls toPaymentPage before reading the total", async () => {
    const order: string[] = [];
    const { deps } = harness();
    deps.toPaymentPage = async () => {
      order.push("toPaymentPage");
    };
    deps.readTotalMinor = async () => {
      order.push("readTotal");
      return 2350;
    };
    deps.jobs.accept(jobInput());
    await runPurchase(deps, jobInput());

    expect(order).toEqual(["toPaymentPage", "readTotal"]);
  });
});
