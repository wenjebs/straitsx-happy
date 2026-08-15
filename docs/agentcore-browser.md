# AWS AgentCore Browser as the browser layer

Investigated 15 Aug 2026 — 5 agents, the AWS docs, and the published SDK exercised locally.

## Verdict

**It fits, and better than Skyvern for this job.** Two reasons, both structural:

1. Its automation endpoint is **plain CDP**. `chromium.connectOverCDP(...)` returns an ordinary
   Playwright `Browser`, so `payWithCard(page, …)` types the card exactly as it does today and the
   number still never reaches a model. `BrowserLike = { newPage() }` is already the seam — the
   runner, the journal, the mandate and the failure ladder all work unchanged.
2. Its live-view endpoint lets **a human take the keyboard mid-session**, in the same Chrome, with
   cookies intact. AWS's own wording for the feature is our exact use case: "enter sensitive
   information like login credentials that you don't want the agent to see." That is an answer to
   a captcha, an SMS code, **or a 3-D Secure challenge** — the wall no automation gets past.

**It does not unblock the demo by itself.** Three things still gate a real purchase, and none of
them is a browser: an AWS account, StraitsX production whitelisting, and whether the card's BIN is
3DS-enrolled.

## What is verified

| Fact | Detail |
|---|---|
| Both endpoints, one session | `StartBrowserSession` returns `streams.automationStream` and `streams.liveViewStream` |
| Automation transport | `wss://bedrock-agentcore.ap-southeast-1.amazonaws.com/browser-streams/aws.browser.v1/sessions/{id}/automation`, SigV4-signed **headers** |
| Live view transport | Same path, `/live-view`, SigV4 **presigned query URL**, hard cap **300 seconds** |
| Take / release control | `UpdateBrowserStream` with `automationStreamUpdate.streamStatus = DISABLED \| ENABLED` |
| Human input | Amazon DCV, real keyboard and mouse at OS level — a cross-origin 3DS iframe is just pixels |
| Region | `ap-southeast-1` (Singapore) |
| Session length | Pass `sessionTimeoutSeconds` explicitly; the docs contradict themselves on the default |
| SDK | `@aws-sdk/client-bedrock-agentcore@3.1106.0` — pinned, since this machine quarantines packages under ~7 days old |

## Order of work

1. **AWS identity.** This machine has **no working AWS credentials** — the default profile is a
   Scaleway one pointing at `sts.nl-ams.amazonaws.com`. Do not touch it; add a named profile.
   ```bash
   aws configure --profile happy set region ap-southeast-1
   aws sts get-caller-identity --profile happy    # must print an arn:aws:iam:: ARN
   ```
2. **IAM.** Eleven `bedrock-agentcore:*` actions, one inline policy, no execution role — an
   execution role is only needed for a *custom* browser, and we deliberately use the managed
   `aws.browser.v1`. `ConnectBrowserAutomationStream` and `ConnectBrowserLiveViewStream` are
   separately grantable, so an operator can be given the live view without automation rights.
3. **Smoke test 1 — does a session start, and do both endpoints come back?** About US$0.002.
   ```bash
   aws bedrock-agentcore start-browser-session --profile happy --region ap-southeast-1 \
     --browser-identifier aws.browser.v1 --session-timeout-seconds 1800
   ```
4. **Session layer** — one new file, `packages/closer/src/agentcore.ts`, returning
   `{ browser, sessionId, liveViewUrl(), close() }`. Nothing else in the repo talks to AWS.
   Call `context.newPage()` on the **default** context, never `browser.newContext()`.
5. **Smoke test 2 — the decision test.** Does `streamStatus=DISABLED` tear down an already-open CDP
   socket? No AWS doc, SDK docstring or sample says. If it does, our `Page` handle dies at the
   exact moment we hand off for 3DS, on a card with ten minutes to live. The same script answers
   two more unknowns for free: does the egress geolocate to SG, and does the browser set
   `navigator.webdriver`.
6. **Smoke test 3 — can `connectOverCDP` fill a cross-origin gateway iframe?** Playwright's own
   docs call CDP "significantly lower fidelity". This is the one thing `payWithCard` depends on.
   Test against a real Shopify checkout with a junk PAN. No card minted, no money at risk.
7. **Wire the runner.** A substitution, not a refactor: `browser: ac.browser`. Prove it offline
   against `apps/demo-store` with `ISSUER=mock` first.
8. **The human gate** goes in `CheckoutOptions.confirm`, so `@happy/pay` is not modified. Detect the
   challenge, mint a live-view URL, alert the operator, poll for the order reference. Returning
   `null` still strands the purchase, so invariant 8 holds.

## Two money-path defects found on the way, in `packages/pay`

Raised with its owner; not changed here.

1. **An inline 3DS challenge guarantees a stranded card.** `checkout.ts` races `waitForNavigation`
   against the submit click and returns `TIMEOUT` when no top-level navigation happens. Stripe's
   3DS is a modal iframe. So today: submit → challenge → timeout → cancel → `STRANDED`, and
   `confirm()` never runs. **Without this fix the entire human-takeover plan is unreachable code.**
2. **`el.fill()` is a documented fraud signal.** Stripe names card numbers "frequently copy-pasted
   rather than typed" and weights behaviour above IP. Worse, Radar's recommended rules include
   `Request 3D Secure if is_missing(:seconds_since_card_first_seen:)` — and our card is always
   brand new. Looking automated *manufactures* the challenge that kills the card.
   `pressSequentially` with a delay costs about four seconds of a ten-minute TTL.

## Guardrails — skip these and you leak the card or lose money

- **Never create a custom browser with recording for the card leg.** Recording captures DOM
  mutations, form interactions, CDP events and network requests into your S3 bucket with **no
  documented masking**. `aws.browser.v1` cannot record, so simply never creating one removes the
  vector.
- **The live view streams rendered pixels.** Whoever holds that URL sees the PAN the instant it is
  typed. Invariant 10 is about code paths; this is a human-eyes exposure outside it. Mint the URL
  only after submit, only to a trusted operator, and never leave a viewer attached during card
  entry.
- **The live view cannot be made read-only.** Only the automation stream has a `streamStatus`.
  Treat the URL as a live keyboard on the payment form.
- **Stop the session explicitly.** `StopBrowserSession` ends billing; do not wait out the TTL.
- **Leave Web Bot Auth off.** It forces a custom browser, it is Preview, and it signs every
  request — including the gateway's calls to Stripe — with headers declaring the traffic automated.

## What this does not fix

**Wall A.** Egress is an AWS datacentre IP, and AWS publishes every range at
`ip-ranges.amazonaws.com`, tagged by region and service. Any merchant classifies us as datacentre
for free, before a line of page JS runs. Shopee will probably still bounce it. A VPC and NAT buys a
stable Elastic IP that is still AWS-owned.

And do not reach for a residential proxy reflexively: Radar's `:is_anonymous_ip:` covers "known
proxy" ranges, and commercial residential pools are widely catalogued, so it could score *worse*.

## Against Skyvern

Skyvern's one real advantage is a managed residential proxy network — and **its country list does
not include Singapore**. For an SG merchant and an SG card, routing through a Japanese exit walks
into Radar's canonical `Block if :card_country: != :ip_country:`. Self-hosted Skyvern bundles no
proxies at all, which is the same bring-your-own work as AgentCore, minus the managed live view.

On the two decisive questions they are closer than the marketing suggests: Skyvern also exposes
`browser_address` for CDP, so the card handoff is not a differentiator. Human takeover is: Skyvern's
is VNC, multi-session VNC for self-hosted is an open feature request, and it is AGPL-3.0.
AgentCore's takeover is a documented managed feature with a console UI and an explicit API.

**Do not run both.** Two browser layers is two fingerprints, two session lifecycles and two things
to debug at 2am.
