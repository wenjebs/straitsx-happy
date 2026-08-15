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

## Smoke test 3 answered — CDP does reach cross-origin card fields (16 Aug, no AWS, no money)

`packages/closer/probe/cdp-iframe.ts`. Playwright's "significantly lower fidelity" warning does
not cost us the thing we depend on.

The probe does not use `apps/demo-store`'s `/checkout-framed`, because that iframe is
**same-origin** and therefore shares its parent's renderer — it cannot exercise the risk. The risk
is specifically Chromium's out-of-process iframes, which appear only across a site boundary. So the
probe serves the outer page from `localhost` and the card frame from `127.0.0.1` — different sites
to Chromium — under `--site-per-process`, then connects with `connectOverCDP` exactly as the
AgentCore adapter will.

| Result | Value |
|---|---|
| `browser.contexts().length` | `1` — the default context is there to `newPage()` on |
| `page.frames()` | `2`, child at `http://127.0.0.1:4032/card-frame` |
| Frame really out-of-process | `true` (`contentDocument === null` from the parent) |
| `fillFirst` found the field | `true` |
| `pressSequentially` digits landed | `true` — 16 read back **from inside the frame** |
| `navigator.webdriver` | `true` |
| UA | `HeadlessChrome/151.0.7922.34` (local launch; AgentCore's will differ) |

**So `payWithCard` needs no change to run over AgentCore.** The transport differs — AgentCore wraps
CDP in a SigV4-signed websocket — but the protocol, and therefore frame fidelity, is identical.

Two caveats this does not settle, both needing real credentials: whether AgentCore's own Chrome
sets `navigator.webdriver` (locally it is Playwright that sets it), and whether the SigV4 websocket
adds latency that matters against a ten-minute card TTL.

## Both `packages/pay` defects are already fixed (verified 16 Aug)

Re-checked before building on them, since the plan called the human-takeover path unreachable
until they landed:

1. **No top-level-navigation wait.** `checkout.ts` has no `waitForNavigation`/`waitForURL`; the
   comment at line 145 names the stranded-card failure explicitly and `confirm()` runs against the
   live page (line 181).
2. **`pressSequentially`, not `fill()`** — line 82, with the fraud-signal reasoning in the comment.

The human-takeover path is reachable. Build on it.

## Measured against the live rail, 16 Aug — account 227493789621, ap-southeast-1

All of it with `ISSUER=mock`, no card, no money. Three sessions, well under a cent.

### The session layer works

`aws.browser.v1` is `READY` in Singapore. `StartBrowserSession` returns both endpoints exactly as
the investigation predicted. `connectOverCDP` accepts the automation websocket when handed SigV4
headers signed for service `bedrock-agentcore` — Playwright's `headers` option is the whole hook,
and nothing below the transport changes. `browser.contexts()` is length 1, so `newPage()` on the
default context works without ever calling `browser.newContext()`.

### The decision test is answered, and the answer is yes

**`UpdateBrowserStream` with `streamStatus=DISABLED` DOES tear down an already-open CDP socket.**
The `Page` dies immediately — `browser.isConnected()` goes `false` within three seconds, and the
next call throws `Target page, context or browser has been closed`.

That is the feared answer. But it is survivable, which the doc did not know:

| After DISABLED → ENABLED → `reconnect()` | Result |
|---|---|
| Fresh `connectOverCDP` succeeds | yes |
| The parked tab is still there | yes — found by URL |
| `document.title` set before the handoff | preserved |
| `sessionStorage` | preserved |
| Cookies | preserved |
| Page drivable again (`goto`) | yes |

**So the recommendation changes.** The doc said "do not call DISABLED at all". Measurement says
call it, and reconnect afterwards:

```
submit → challenge detected → setAutomationEnabled(false) → mint live view →
human clears 3DS → operator signals done → setAutomationEnabled(true) →
reconnect() → find the tab by URL → confirm()
```

This is strictly better than idling with automation enabled, because the agent is genuinely locked
out while a human has the keyboard — no two parties fighting over the same form. The cost is that
the agent cannot poll during the handoff, so the "done" signal has to come from the operator.

One wrinkle worth knowing: after reconnect, `pages()` also contains `chrome://new-tab-page/`.
Select the working tab by URL, never by index.

### Egress and fingerprint

| | |
|---|---|
| Egress IP | `54.179.94.175` |
| Country / region | **SG / Singapore** — so Radar's `Block if :card_country: != :ip_country:` does not fire |
| Org | `AS16509 Amazon.com, Inc.` — datacentre, publicly listed, as expected |
| `navigator.webdriver` | **`false`** — AgentCore does not set it (locally it is Playwright that does) |

### The fingerprint problem nobody predicted: the User-Agent self-identifies

```
Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0
Amazon-Bedrock-AgentCore-Browser/1.0 (Chromium; +https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-tool.html)
```

AgentCore appends its own product token, with a documentation URL. This is a **worse** signal than
either the datacentre IP or `navigator.webdriver`, because the UA is read at the CDN and WAF layer
before a line of page JS runs — Cloudflare, Akamai and Stripe Radar all see it on the very first
request. Any merchant that cares is now told, in plain text, that this is an AWS agent browser.

It is also, read another way, AWS behaving honestly: the token is there so sites *can* identify
automated traffic. Overriding it via `Emulation.setUserAgentOverride` is technically one CDP call
and is deliberately **not** implemented here — that is concealment from a site that has chosen to
look, and it is wenjie's call, not the library's default.

### Cross-origin iframes, over the real transport

Repeating `probe/cdp-iframe.ts`'s question through the SigV4 websocket: child frame seen, genuinely
out-of-process (`contentDocument === null` from the parent), reachable, `frame.title()` read
successfully. `payWithCard`'s `page.frames()` works over AgentCore.

### The decisive test: a real Shopify checkout, end to end, over AgentCore

Nylon Coffee Roasters (`nylon.coffee`), chosen from `docs/merchant-shortlist.md` as the cleanest
Shopify Payments setup found. Driven entirely through the AgentCore CDP connection: storefront →
quick add → cart (Kenya AB Kiamwangi, S$23.50, inside the S$5–30 card bounds) → checkout.

Nothing was submitted, no card was minted, no money moved. The PAN below is the well-known junk
test number.

| | |
|---|---|
| Reached the real checkout | yes — `nylon.coffee/checkouts/cn/…`, no bot wall |
| Frames on the payment page | **11** |
| Card-field host | `checkout.pci.shopifyinc.com` — a genuine cross-origin PCI iframe |
| `number` / `expiry` / `cvc` / `name` | **all four found**, all inside that iframe, by our existing `SELECTORS` |
| `pressSequentially` into the iframe | **worked** — Shopify formatted it to `4242 4242 4242 4242` and detected Visa |
| Total read from the page | SGD $23.50, "Including $1.94 in taxes" |

**This is `payWithCard` proven against a real merchant over AgentCore, with no code change.** The
`connectOverCDP` fidelity question, the OOPIF question and the "does typing reach the gateway"
question are now all answered on the real thing rather than a local stand-in.

### Merchants, measured rather than predicted

Five merchants launched simultaneously through `demo/agentcore-server.ts`, plus earlier one-offs.
The distinction that matters is **not** blocked/allowed — it is whether a human at the live view
has anything to *do*. A captcha is survivable; a bounce is not.

| Site | Result | Can a human rescue it? |
|---|---|---|
| **FairPrice** | **loads completely** — real storefront, live prices, no wall | not needed |
| **Nylon Coffee** (Shopify) | **loads, all the way to the card form** | not needed |
| `example.com`, `openstreetmap.org`, `ipinfo.io` | fine | — |
| **Lazada** | **slider captcha** — "Please drag the slider to verify" | **yes** — drag it in the live view |
| **Google search** | **reCAPTCHA** — `/sorry/index`, "unusual traffic from your computer network" | **yes** — cleared, session continued on real results with cookies intact |
| **Shopee** | **hard bounce** → `/verify/traffic/error?…&is_logged_in=false`, "Page Unavailable" | **no** — nothing to solve |
| **Amazon SG** | **soft bot block** → "Website Temporarily Unavailable" | **no** — nothing to solve |

So the three-way split is: some merchants do not care, some throw a challenge that a human clears
in seconds, and some refuse without offering a door. Only the third group is actually lost, and it
is a minority — which is a much better result than "Shopee will probably bounce it" implied.

Shopee and Amazon are the only true losses, and both were already ruled out by
`docs/merchant-shortlist.md` for an unrelated reason: they require an account, and account creation
needs a code sent to a phone.

One hint before writing Shopee off entirely: its bounce URL carries `is_logged_in=false`, and the
only action the page offers is **Log In**. An authenticated session may pass where an anonymous one
does not — and the live view is exactly how an operator logs in without the password ever reaching
the agent or a model prompt. Untested.

Egress IPs rotate within AWS Singapore across sessions (`54.179.94.175`, then `18.143.40.65`), so
there is no single address to get allowlisted, and a merchant cannot durably block one either.

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
