# Where the agent can actually buy something — Singapore, 15 Aug 2026

Research: 13 agents, four research angles, an adversarial pass that killed 3 of 8 candidates, and
live checkout probing. Every merchant below was reached by an automated browser as a guest.

## The verdict

**No merchant is safe for a fully unattended run, and the merchant is not the reason.** Nobody
knows whether the StraitsX card is enrolled in 3-D Secure. If it is, no merchant setting can stop a
challenge, because Shopify and Stripe both escalate when the issuer asks them to. Plan for a human
standing by.

**Marketplaces are all out.** Shopee, Lazada, Amazon.sg, FairPrice, Decathlon and COURTS each
require an account, and account creation needs a code sent to a phone. Qoo10 no longer exists.
**Never point the agent at Carousell:** it places a S$0.50 hold when a card is first linked, and our
card dies on its first authorisation — it would die at the linking step, before any purchase.

The category that works is a **Singapore retailer's own Shopify shop**.

## The four

| | Shop | Buy | All-in | The good part | The risk |
|---|---|---|---|---|---|
| 1 | [Wardah Books](https://wardahbooks.com) | Any book S$5–30, **local pickup** at 58 Bussorah Street | Exactly the listed price | Pickup removes shipping from the sum entirely, so the mint amount is the shelf price. Lets you risk exactly S$5.00 on the first real card. | A second gateway tile (HitPay) sits on the page and redirects offsite if clicked |
| 2 | [Nylon Coffee Roasters](https://nylon.coffee) | Coffee S$23.50–24.00, or filters at S$6.50 | S$9.30–S$27.80, flat S$3.80 courier | Cleanest payment setup found anywhere: Shopify Payments is the only real gateway, no wallet to wander into | Unsettled question of whether GST applies on top of shipping — read the total, never compute it |
| 3 | [the little dröm store](https://thelittledromstore.com) | Singapore-themed gifts, S$6.90–19.90 | S$8.80–S$21.80, flat S$1.90 | Best demo optics, and shipping cannot push a total past S$30 | Heavy probing put an IP into a sticky Cloudflare challenge for over five minutes. Rehearse sparingly |
| 4 | [Yong Seng Coffee](https://yongsengcoffee.com) | Kopi, S$6.00–9.10 | S$10.70–S$15.00 | The cheap delivery option is preselected, so the hazard is "do not change it" rather than "must pick it" | 38 of 391 variants are taxable, so the total must be read, never computed |

Reserve: [Prodigal Roasters](https://prodigalroasters.com) — flat S$5.00 shipping, phone optional.

## The engineering blocker, verified

Shopify puts the card fields in a cross-origin iframe (`checkout.pci.shopifyinc.com`). The
attributes are exactly the ones `payWithCard` looks for, but `page.locator` does not cross frames:

```
page.locator('input[autocomplete="cc-number"]') finds: 0
```

Until `@happy/pay` searches frames, **no real purchase is possible at any of these shops.** Raised
with its owner. Every alternative gateway is worse: HitPay redirects offsite, EasyStore posts to the
gateway, 2C2P turns 3DS on by default.

## Ask StraitsX tonight

1. Is the production BIN enrolled in 3-D Secure? **This one answer decides whether the demo is
   workable or a coin flip.** If it is not enrolled, challenges resolve to "attempted" and pass.
2. If it is enrolled, what answers the challenge, and can it be made frictionless?
3. Does a **declined** authorisation burn the card, or only an approved one?
4. What cardholder name and billing address does the card carry?
5. What BIN country and funding type do merchants see?
6. Which merchants has StraitsX already driven end to end?

Also confirm production cards are SGD and not USD. One source says S$5–30, another says US$5–50.

## The order of work, cheapest first

Everything up to step 7 is free. Nothing before the mint costs anything.

1. Offline run against `apps/demo-store` — the state machine, on mock. **Done.**
2. Drive the real shop to the payment page and stop. No card involved.
3. Type junk digits into the card iframe and read them back. This closes the frame question.
4. Read the committed total after address and delivery are set. That number, and only that number,
   is what gets minted.
5. Make the pre-mint gate code, not a checklist: guest confirmed, card option selected, total in
   band, no captcha, no login redirect. Any failure aborts before issuance.
6. Repeat 2–5 from the demo machine, on the demo network, once — not fifty times.
7. Buy the same item with a **personal credit card** through the same automation. This is the only
   way to see what the authorisation does while a refund still exists.
8. Confirm the sandbox rail still mints and reconciles.
9. First real card, minimum stake: Wardah Books pickup at exactly S$5.00, human watching.
10. Record the confirmation number, the thank-you URL, and the email. Anything less is a failure.
11. The demo run, at full value. Assume one shot.

## Decide before the run

- **Who watches, and the abort rule.** Suggested: abort before the mint on any captcha, login wall
  or total mismatch. After the mint, do not intervene — the money has moved — just record it.
- **The likeliest bad ending is not a decline.** It is Stripe scoring the order "elevated": the
  money is captured, a reference appears, the demo looks fine, and a small shop cancels it days
  later and refunds to a card that no longer exists. That is `STRANDED`.
- **Use a Singapore residential connection.** Datacentre egress is one of the cheapest ways to push
  the risk score up.
- **How many cards may be burned.** Each failed attempt costs the full amount, because spend is
  recognised at issuance.
