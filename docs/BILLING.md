# Billing and licensing — how it works, and what you must configure

## The chain

```
  browser              Razorpay            /api/webhook           Supabase
  ───────              ────────            ────────────           ────────
  pick seats  ──────>  takes payment ────> verifies signature ──> stores licence
                                           mints the key
                                           emails it (Resend)
                                                  │
  /api/license  <───── polls for the key ─────────┘
  (recovery)

  relay (server.js) ──> /api/validate ──> Supabase
       admits or refuses, using seats FROM THE RECORD
```

**One rule holds the whole thing together: only the webhook may mint a licence, and only
the stored record may grant entitlement.** The browser cannot invent a key, and the relay
never reads anything meaningful out of the key string.

That rule is why the old flow was replaced. Previously the browser built
`HC-PRO-<seats>-<paymentId>` and showed it in an `alert()`; the relay accepted anything
starting with `HC-PRO-` and read the seat count out of field 3. So `HC-PRO-9999-anything`
granted 9,999 committers to anyone who typed it, while a real buyer's key was never
recorded anywhere and was lost the moment they dismissed the dialog.

## What you must configure

### Vercel → Project → Settings → Environment Variables

| Variable | Required | What it does |
|---|---|---|
| `SUPABASE_URL` | **yes** | `https://<project>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | service_role key. Server-side only — it bypasses RLS, so it must never reach a browser. |
| `RAZORPAY_WEBHOOK_SECRET` | **yes** | From the Razorpay webhook config. Without it `/api/webhook` refuses every request (fails closed) rather than processing unverified payment events. |
| `RESEND_API_KEY` | recommended | Licence delivery email. Without it the licence is still stored and still recoverable via `/api/license`, but nothing is sent. |
| `LICENSE_FROM_EMAIL` | with Resend | e.g. `Hivecode <keys@yourdomain.com>` — must be a domain verified in Resend. |

### Relay (Render, or wherever `server.js` runs)

| Variable | Default | What it does |
|---|---|---|
| `HIVE_REQUIRE_LICENSE` | unset (off) | Set to `true` to enforce. **While unset, every room is free and open** — that is the current production state. |
| `HIVE_LICENSE_API` | `https://hivecode.vercel.app/api/validate` | Where the relay checks keys. |
| `HIVE_LICENSE_TIMEOUT` | `4000` | ms before a validator call is abandoned. |
| `HIVE_LICENSE_GRACE_MS` | `86400000` (24h) | How long a previously-valid licence keeps working if the validator is unreachable. A billing outage must not look like an expired subscription. |

The relay deliberately calls the API instead of querying Supabase directly, so the
service-role key stays in Vercel and never lands on the relay host.

### Supabase

Run [`supabase/schema.sql`](../supabase/schema.sql) once in the SQL editor. It is
idempotent, so re-running it is safe. RLS is enabled with no policies, which means the
anon and authenticated keys can read nothing — only `service_role` can.

### Razorpay dashboard

1. Replace the test key in the page: `data-razorpay-key` on the Upgrade button in
   `public/index.html`.
2. Add a webhook pointing at `https://hivecode.vercel.app/api/webhook`, with the secret you
   put in `RAZORPAY_WEBHOOK_SECRET`.
3. Subscribe it to: `payment.captured`, `subscription.activated`, `subscription.charged`,
   `subscription.cancelled`, `subscription.halted`, `refund.processed`.

## After the payment: one set of instructions, three surfaces

A buyer meets the setup steps three times — in the dialog that opens the moment the payment
clears, in the licence email, and on the website. Those three used to be written
independently, and the email told people to run **"Hivecode: Set Licence Key"**, which is not
a command the extension contributes. Following it produced nothing, which to the person who
just paid is indistinguishable from a broken product.

The steps now live in [`shared/onboarding.js`](../shared/onboarding.js) as data, and every
surface renders that array:

| Surface | Renders | Form |
|---|---|---|
| `api/_email.js` | `setupStepsAsText()` + an HTML table | full prose, both MIME parts |
| `web/src/checkout.ts` → post-payment dialog | `SETUP_STEPS` | titles + literals only, links to `/#setup` |
| `public/index.html` → `#setup` | hand-written markup | full prose, with copy buttons |

The page is deliberately static markup rather than JS-rendered, so it works without the
bundle and is indexable — which means it *can* drift. Two guards catch that instead:

- `tests/billing-test.mjs` asserts every rendered `kind: 'command'` literal is a title the
  extension actually contributes in `extension/package.json`. A renamed command fails the
  suite rather than reaching a customer.
- The page checker asserts every step title, body and literal appears in `public/index.html`
  verbatim.

If you reword a step, change it in `shared/onboarding.js` and update the markup to match;
the checks will tell you which surface you missed.

## Known gap: the extension gates nothing

`requirePro()` exists in `extension/extension.js` and is **never called**, and
`FREE_MAX_AGENTS` / `FREE_MAX_DURATION_MS` are declared and never read. `proTier` only drives
the Free/Pro badge in the panel. So every feature the pricing page attributes to Pro —
private rooms, restore points, undo-by-agent, the provenance ledger — is currently available
to everyone in the editor.

The only real gate is the relay's committer limit, and that is inactive too while
`HIVE_REQUIRE_LICENSE` is unset. Before charging anyone, decide deliberately which of the two
you want enforcement to live in: the relay (harder to bypass, but only covers hosted rooms)
or the extension (covers editor-side features, but a client-side check is advisory by nature).

## Known gap: billing is one-off, not recurring

The page advertises **$29 per committer per month**, but the checkout creates a **one-time
payment**, and the issued licence has no expiry. So today a customer pays once and keeps
working indefinitely. The server side is already built for recurring billing — the webhook
handles `subscription.activated`, `.charged`, `.cancelled` and `.halted`, and marks the
licence accordingly — but nothing creates a Razorpay *subscription*.

Closing it needs three things:

1. A Razorpay Plan (dashboard) at $29/month per unit.
2. A small `POST /api/subscribe` that creates a subscription for N units with your
   Razorpay API keys, returning `subscription_id`.
3. The checkout switching from `amount` to `subscription_id`.

Until then, either treat sales as one-off perpetual licences (and change the pricing copy
to match), or set `expires_at` on issue and check it in `/api/validate`.

## Tests

```bash
npm run test:billing   # format, seat clamping, signature enforcement, idempotency
npm run test:license   # a real relay process refusing a forged key at the handshake
npm run test:money     # both
```

`test:license` spawns the actual relay against a fake validator and asserts that
`HC-PRO-9999-pay_anything` is answered **402**, not admitted. That is the regression test
for the bypass; keep it passing.

## Failure semantics (deliberate)

- A validator or database failure returns **503**, never `valid: false`. "We could not
  check" and "you did not pay" must never be the same answer.
- `/api/webhook` returns **500** on internal failure so Razorpay retries; silently
  swallowing an error would drop a paid licence.
- Webhook handling is **idempotent** by `subscription_id` then `payment_id`, because
  Razorpay retries until it gets a 2xx and a retry must not mint a second licence.
- Email failure never fails the webhook — the licence is stored first, so delivery
  problems degrade to "recoverable via `/api/license`" instead of losing a purchase.
