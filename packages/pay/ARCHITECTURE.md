# How @happy/pay works
## 1. The files

Your agent only ever touches `index.ts`. Everything below it is internal.

```mermaid
flowchart TD
    A["your agent"] --> B["index.ts<br/><i>the only public surface</i>"]

    B --> C["rules.ts<br/><i>should we buy this?</i>"]
    B --> D["ledger.ts<br/><i>limits, budget, states</i>"]
    B --> E["purchase.ts<br/><i>buy the card, carefully</i>"]
    B --> F["checkout.ts<br/><i>type the card into the form</i>"]

    D --> C
    E --> C
    E --> D
    E --> G

    subgraph issuer ["issuer/ — swappable"]
        G["mock.ts<br/><i>free, offline, default</i>"]
        H["straitsx.ts<br/><i>real money</i>"]
    end

    H --> I["x402/client.ts<br/><i>the pay-me-first handshake</i>"]
    H --> J["x402/bucket.ts<br/><i>don't spam the server</i>"]

    subgraph bg ["running in the background"]
        K["wallet.ts<br/><i>balance + chain reads</i>"]
        L["recon.ts<br/><i>fix anything left in flight</i>"]
    end

    B -.starts.-> K
    B -.starts.-> L
    L --> K
    L --> D

    subgraph store ["storage"]
        M["db.ts<br/><i>SQLite, 5 tables</i>"]
        N["audit.ts<br/><i>append-only history</i>"]
    end

    D --> M
    D --> N
    E --> N
    F --> N
```

## 2. One purchase, start to finish

The happy path. Note where money actually moves — step 9, and nowhere else.

```mermaid
sequenceDiagram
    autonumber
    participant You as your agent
    participant Pay as index.ts
    participant Rules as rules.ts
    participant DB as SQLite
    participant Card as issuer
    participant Rail as card server
    participant Web as merchant page

    You->>Pay: createMandate(limits)
    Pay->>DB: save the rules

    You->>Pay: evaluate(quote)
    Pay->>DB: read limits + what's spent
    Pay->>Rules: decide
    Rules-->>You: ALLOW / NEEDS_HUMAN / DENY
    Note over You,Rules: free — nothing written, nothing sent

    You->>Pay: reserve(quote)
    Pay->>DB: decide + insert, one transaction
    DB-->>You: purchase RESERVED, budget held

    Note over You,Web: your agent drives the browser to checkout<br/>and reads the real final total

    You->>Pay: issueCard(id, finalTotal)
    Pay->>Rules: re-decide against the REAL total
    Pay->>Card: prepare — sign, send nothing
    Card->>Rail: ask for a card
    Rail-->>Card: 402 Payment Required, here's the price
    Card-->>Pay: signed payment, not yet sent

    rect rgb(255, 243, 224)
        Pay->>DB: save the signed payment FIRST, mark PAYING
        Note right of DB: the crash-safety hinge —<br/>a crash after this is recoverable
    end

    Pay->>Card: send — irreversible
    Card->>Rail: same request, now with payment
    Rail-->>Card: here's your card
    Pay->>DB: mark CARD_ISSUED

    You->>Pay: payWithCard(page, id)
    Pay->>Card: reveal the digits
    Pay->>Web: type them in, submit
    Web-->>Pay: order reference
    Note over Pay: digits dropped immediately —<br/>never saved, never logged

    You->>Pay: complete(id, orderRef)
    Pay->>DB: DONE
```

## 3. What state is a purchase in?

```mermaid
stateDiagram-v2
    [*] --> RESERVED

    RESERVED --> PAYING
    PAYING --> CARD_ISSUED
    CARD_ISSUED --> DONE
    DONE --> [*]

    RESERVED --> RELEASED
    CARD_ISSUED --> STRANDED
    PAYING --> FAILED
    PAYING --> STRANDED
    FAILED --> STRANDED

    note left of RESERVED
        reserve() — budget held for 15 min
        exits to RELEASED if you cancel
        or the hold expires
    end note

    note right of PAYING
        payment signed and saved, then sent.
        you CANNOT cancel from here —
        nobody knows yet if the money left.
        the reconciler resolves it.
    end note

    note right of STRANDED
        money gone, no usable card.
        recorded honestly rather than
        pretending it was refunded.
    end note

    note left of FAILED
        the payment provably never landed.
        if the reconciler later finds the
        money DID leave, it corrects to
        STRANDED — the one non-terminal exit,
        so a crash can't lose money quietly.
    end note
```

## 4. The decision

Every gate in `rules.ts`, in order. First match wins. No database, no network — just this.

```mermaid
flowchart TD
    S(["evaluate / reserve / issueCard"]) --> A{"mandate active<br/>and not expired?"}
    A -- no --> D1[["DENY"]]
    A -- yes --> B{"S$5 to S$30?"}
    B -- no --> D2[["DENY<br/>card server won't issue"]]
    B -- yes --> C{"merchant on<br/>your list?"}
    C -- no --> D3[["DENY"]]
    C -- yes --> E{"price crept up<br/>since the quote?"}
    E -- "more than 2%" --> D4[["DENY"]]
    E -- no --> F{"blows the<br/>daily cap?"}
    F -- yes --> D5[["DENY"]]
    F -- no --> G{"balance reading<br/>fresh enough?"}
    G -- "stale" --> D6[["DENY<br/>won't guess"]]
    G -- fresh --> H{"enough money?"}
    H -- no --> D7[["DENY"]]
    H -- yes --> I{"over the<br/>per-item cap?"}
    I -- yes --> J[["NEEDS_HUMAN<br/>ask your person"]]
    I -- no --> K[["ALLOW"]]
```

The price check only runs at `issueCard` time, when there's a quote to compare against.

**`NEEDS_HUMAN` is a gate, not a warning.** At `issueCard` the decision runs again against the
real total, and if it comes back `NEEDS_HUMAN` the purchase is refused unless `approve()` was
called for it. That matters because the quote can be under your per-item cap while the final
charge is over it — a merchant nudging the price up between the two would otherwise buy a card
above the limit with nobody asked.

**One more safety net at issuance.** The raw response from the card server is written to
`card-responses/<nonce>.json` (owner-only, gitignored) *before* anything tries to parse it.
Nobody has seen a real success response from that endpoint, so the code that extracts the card
number is working from an educated guess — if it guesses wrong, the file is the difference
between "money gone, card unreadable" and "money spent, digits on disk, type them in by hand."
Delete those files once the card is used; they contain live card data.

## 5. When it goes wrong

Every 10 seconds, `recon.ts` cleans up. This is what makes a crash survivable.

```mermaid
flowchart TD
    T(["every 10 seconds"]) --> A["release reservations<br/>past their 15 minutes"]
    T --> B{"any payment still<br/>unresolved?"}
    B -- no --> Z(["done"])
    B -- yes --> C{"past its deadline?"}
    C -- "not yet" --> Z
    C -- yes --> D{"ask the chain:<br/>did this payment<br/>actually go through?"}

    D -- no --> E["it never happened<br/>→ FAILED, budget returned"]

    D -- yes --> F["money left. re-send the saved payment<br/>to get the card back.<br/>safe — it can't pay twice"]
    F --> G{"what came back?"}
    G -- "the card" --> H["→ CARD_ISSUED<br/>recovered"]
    G -- "a hiccup<br/>(429, dropped socket)" --> J["leave it alone,<br/>retry next tick"]
    G -- "nothing to replay" --> I["→ STRANDED<br/>money gone, recorded honestly"]
    J -.-> T
```
