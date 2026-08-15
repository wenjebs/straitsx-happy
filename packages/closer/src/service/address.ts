import type { Frame, Locator, Page } from "playwright";

/** What Happy sends with the job. Everything is optional to fill — checkouts ask for different sets. */
export type ShippingAddress = {
  recipientName: string;
  addressLine1: string;
  addressLine2?: string | undefined;
  city: string;
  stateOrProvince?: string | undefined;
  postalCode: string;
  country?: string | undefined;
  phone?: string | undefined;
  email?: string | undefined;
};

/**
 * Fills the delivery address before the card is claimed.
 *
 * Runs while failure is still free: an address field this misses costs a retry, whereas the same
 * miss after issuance strands a live card. Best-effort by design — a checkout that already has a
 * saved address, or asks for fields we do not hold, must not fail the purchase.
 *
 * Kept apart from `fill.ts` deliberately. That file's rules exist because card fields are hidden
 * in gateway iframes and shadowed by decoys; address fields are ordinary page inputs, and mixing
 * the two invites someone to relax a card rule to make an address work.
 */
const SELECTORS = {
  email: ['input[autocomplete="email"]', 'input[type="email"]', 'input[name*="email" i]'],
  recipientName: [
    'input[autocomplete="name"]',
    'input[name="name"]',
    'input[name*="full" i][name*="name" i]',
    'input[id*="fullname" i]',
  ],
  firstName: ['input[autocomplete="given-name"]', 'input[name*="first" i][name*="name" i]'],
  lastName: ['input[autocomplete="family-name"]', 'input[name*="last" i][name*="name" i]'],
  addressLine1: [
    'input[autocomplete="address-line1"]',
    'input[autocomplete="shipping address-line1"]',
    'input[name="address1"]',
    'input[name*="address" i][name*="1" i]',
    'input[id*="address1" i]',
    'input[name="street"]',
  ],
  addressLine2: [
    'input[autocomplete="address-line2"]',
    'input[name="address2"]',
    'input[name*="address" i][name*="2" i]',
    'input[id*="address2" i]',
    'input[name*="apartment" i]',
    'input[name*="unit" i]',
  ],
  city: [
    'input[autocomplete="address-level2"]',
    'input[name="city"]',
    'input[name*="city" i]',
    'input[id*="city" i]',
  ],
  stateOrProvince: [
    'input[autocomplete="address-level1"]',
    'input[name="province"]',
    'input[name*="state" i]',
    'input[name*="region" i]',
  ],
  postalCode: [
    'input[autocomplete="postal-code"]',
    'input[name="zip"]',
    'input[name*="postal" i]',
    'input[name*="zip" i]',
    'input[id*="postcode" i]',
  ],
  phone: ['input[autocomplete="tel"]', 'input[type="tel"]', 'input[name*="phone" i]'],
} as const;

type Field = keyof typeof SELECTORS;

const MIN_FIELD_WIDTH = 60;

async function usable(el: Locator): Promise<boolean> {
  if ((await el.count()) === 0) return false;
  if (!(await el.isVisible().catch(() => false))) return false;
  if (!(await el.isEditable().catch(() => false))) return false;
  const box = await el.boundingBox().catch(() => null);
  return box !== null && box.width >= MIN_FIELD_WIDTH;
}

function scopes(page: Page): (Page | Frame)[] {
  return [page, ...page.frames().filter((f) => f !== page.mainFrame())];
}

async function fillField(page: Page, field: Field, value: string): Promise<boolean> {
  for (const selector of SELECTORS[field]) {
    for (const scope of scopes(page)) {
      const el = scope.locator(selector).first();
      if (!(await usable(el))) continue;
      // Leave a checkout's own saved value alone rather than doubling it up.
      const current = await el.inputValue().catch(() => "");
      if (current.trim() !== "") return true;
      await el.click();
      await el.pressSequentially(value, { delay: 20 });
      return true;
    }
  }
  return false;
}

/** Selects the country by visible label when the checkout uses a dropdown. */
async function selectCountry(page: Page, country: string): Promise<boolean> {
  const selectors = [
    'select[autocomplete="country"]',
    'select[name="country"]',
    'select[name*="country" i]',
  ];
  for (const selector of selectors) {
    for (const scope of scopes(page)) {
      const el = scope.locator(selector).first();
      if ((await el.count()) === 0) continue;
      const chosen = await el.selectOption({ label: country }).catch(() => null);
      if (chosen) return true;
    }
  }
  return false;
}

/** Returns the fields it managed to fill, for the run log. Never throws. */
export async function fillAddressInto(page: Page, address: ShippingAddress): Promise<Field[]> {
  const filled: Field[] = [];
  const attempts: [Field, string | undefined][] = [
    ["email", address.email],
    ["recipientName", address.recipientName],
    ["addressLine1", address.addressLine1],
    ["addressLine2", address.addressLine2],
    ["city", address.city],
    ["stateOrProvince", address.stateOrProvince],
    ["postalCode", address.postalCode],
    ["phone", address.phone],
  ];

  for (const [field, value] of attempts) {
    if (!value) continue;
    const ok = await fillField(page, field, value).catch(() => false);
    if (ok) filled.push(field);
  }

  // Checkouts that split the name still need one: try given/family with the same value split.
  if (!filled.includes("recipientName") && address.recipientName) {
    const [first = address.recipientName, ...rest] = address.recipientName.split(" ");
    const firstOk = await fillField(page, "firstName", first).catch(() => false);
    if (firstOk) {
      filled.push("firstName");
      if (rest.length > 0) {
        const lastOk = await fillField(page, "lastName", rest.join(" ")).catch(() => false);
        if (lastOk) filled.push("lastName");
      }
    }
  }

  if (address.country) await selectCountry(page, address.country).catch(() => false);

  return filled;
}
