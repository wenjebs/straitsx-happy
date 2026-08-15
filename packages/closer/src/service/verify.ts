/**
 * Everything that must be true before a card is claimed.
 *
 * Ordered deliberately: these run while a failure is still free. Once the card exists it has about
 * ten minutes and is destroyed by its first authorisation, so a check that fires after issuance
 * costs a card whatever it decides.
 */
export type PurchaseJobInput = {
  activityId: string;
  attemptId: string;
  item: { id: string; name: string; spec?: string | undefined };
  listing: {
    url?: string | undefined;
    title: string;
    seller: string;
    price: string;
    amountMinor: number;
  };
  cardGrant: {
    claimUrl: string;
    token: string;
    amountMinor: number;
    currency: string;
    expiresAt: string;
  };
  /** The buyer's delivery address, filled into the checkout before any card is claimed. */
  shippingAddress?:
    | {
        recipientName: string;
        addressLine1: string;
        addressLine2?: string | undefined;
        city: string;
        stateOrProvince?: string | undefined;
        postalCode: string;
        country?: string | undefined;
        phone?: string | undefined;
        email?: string | undefined;
      }
    | undefined;
  sandbox: boolean;
  idempotencyKey: string;
  amountMinor: number;
  callback: { url: string; token?: string | undefined };
};

/** Returns a human-readable reason, or null when the payload is sound. */
export function verifyGrant(job: PurchaseJobInput, now: Date = new Date()): string | null {
  const url = job.listing.url;
  if (!url) return "listing has no url, so there is nothing to verify against";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `listing url is not a url: ${url}`;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return `listing url is not http(s): ${parsed.protocol}`;
  }

  if (job.cardGrant.currency !== "SGD") {
    return `card grant currency is ${job.cardGrant.currency}, expected SGD`;
  }
  if (job.cardGrant.amountMinor !== job.listing.amountMinor) {
    return `card grant amount ${job.cardGrant.amountMinor} does not equal listing amount ${job.listing.amountMinor}`;
  }
  if (job.amountMinor !== job.listing.amountMinor) {
    return `job amount ${job.amountMinor} does not equal listing amount ${job.listing.amountMinor}`;
  }

  const expires = Date.parse(job.cardGrant.expiresAt);
  if (Number.isNaN(expires)) return `card grant expiresAt is not a date: ${job.cardGrant.expiresAt}`;
  if (expires <= now.getTime()) return "card grant has expired";

  return null;
}

/**
 * The merchant's own displayed total against what was approved.
 *
 * Read from the page, never computed and never taken from the payload — a merchant that nudges the
 * price a couple of percent between shortlist and checkout is exactly what this catches.
 */
export function verifyMerchantTotal(displayedMinor: number, approvedMinor: number): string | null {
  if (!Number.isFinite(displayedMinor)) return "could not read a total from the merchant's page";
  if (displayedMinor > approvedMinor) {
    return `merchant total ${displayedMinor} exceeds approved ${approvedMinor}`;
  }
  return null;
}
