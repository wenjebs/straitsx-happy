# Connected accounts — what the app needs to add

The agent can shop inside an account the user has connected. The library side is built and tested
(`packages/closer/src/profiles.ts`). This is what the API and the UI still need.

## The rule that shapes everything

**We never store a password.** The user signs in by hand, in a real browser window, on their own
machine. We keep the session the shop issued. Nothing else.

Three reasons, in order of weight:

1. A stored password is a breach waiting to happen, and it buys nothing: the shops that need an
   account are the same ones that answer a scripted sign-in with a one-time code or a puzzle.
2. A person can answer a code or a puzzle. A stored password cannot.
3. The user can revoke us at any time, from either side — delete the profile here, or sign out
   there.

The session cookie **is** account access. The profile directory is created `0700`, is gitignored,
and the disconnect button deletes it.

## What the library gives you

```ts
import { createProfileStore } from "@happy/closer";

const store = createProfileStore();          // CLOSER_PROFILE_DIR, default ./closer-profiles

store.list();                                 // MerchantProfile[] for the settings screen
store.status("shopee.sg");                    // { host, connected, connectedAt }
await store.connect(host, loginUrl, waitFor); // opens the window, waits for the person
store.disconnect("shopee.sg");                // forgets the session
await store.contextFor("shopee.sg");          // the signed-in browser context for a run
```

`waitFor` is how the caller says "the person has finished". The command line waits for a keypress.
The app waits for the user to press **Done** in the connect dialog.

Then a run picks the right session per shop:

```ts
createCloser({ browser: (host) => store.contextFor(host), onEvent });
```

## Endpoints to add

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/v1/merchants` | — | `MerchantProfile[]` |
| `POST` | `/v1/merchants/:host/connect` | `{ loginUrl }` | opens the window; `MerchantProfile` when the user is done |
| `POST` | `/v1/merchants/:host/done` | — | ends the wait started by `connect` |
| `DELETE` | `/v1/merchants/:host` | — | `MerchantProfile` |

```jsonc
// MerchantProfile
{ "host": "shopee.sg", "connected": true, "connectedAt": "2026-08-15T14:41:02.000Z" }
```

`connect` opens a window on the machine that runs the agent. This works because that machine is the
user's own. A hosted version for many users needs one isolated browser for each user, and that is
not built.

## What the screen shows

A list of shops, each with one of three states:

- **Not connected** — a **Connect** button. It opens the sign-in window.
- **Connected**, with the date — a **Disconnect** button.
- **Expired** — the shop signed us out. The same **Connect** button.

The app cannot tell "connected" from "expired" without asking the shop. Test it by loading a page
that needs an account, in the saved session, and see whether the shop shows it. Do this when the
user opens the settings screen, not on a timer.

## What this does not solve

Two failures remain, and no session fixes either:

1. **A code at the payment step.** Some shops ask for a one-time code for a new card. Our card is
   single-use and dies in about ten minutes. Nobody is at the keyboard, so the card dies for
   nothing. The answer is an attended mode: the agent stops, the app asks the user, the user
   answers, the agent continues. It is not built.
2. **A shop that refuses automation.** Shopee sends an automated browser to
   `/verify/traffic/error` before it shows a product page. Being signed in may pass that check.
   If it does not, we do not fight it. We use a shop that permits the purchase.
