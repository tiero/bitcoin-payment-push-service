# bitcoin-payment-push-service

A small sample service that sends a **push notification to your phone when a
Bitcoin Lightning payment is received** in an [Arkade](https://docs.arkadeos.com)-enabled wallet.

Receiving Lightning in Arkade works via a **Boltz reverse submarine swap**: the
wallet generates a BOLT11 invoice (a reverse swap identified by a `swapId`); when the
payer pays, Boltz funds/locks the VTXO (**`transaction.mempool`**, "claimable") and
the phone then claims it. This service pushes at the *claimable* stage — Boltz has
already been paid on Lightning, so the money is the user's; the push **wakes the
wallet app** (phones can't run reliable background jobs) so it can finalize the
claim. We push once, at claimable — not again on `invoice.settled`.

It is built on the official Arkade packages — [`@arkade-os/sdk`](https://www.npmjs.com/package/@arkade-os/sdk)
and [`@arkade-os/boltz-swap`](https://www.npmjs.com/package/@arkade-os/boltz-swap) —
and uses the SDK's `SwapManager` for monitoring. There is **no hand-rolled Boltz
client and no raw REST**: `SwapManager` owns the single multiplexed Boltz websocket,
the polling fallback, and the reconnect/backoff logic.

## How it works

```
wallet ──POST /register {swap, topic}──▶ service ── @arkade-os/boltz-swap SwapManager ──▶ Boltz
  (creates invoice via                      │          (one ws, swap.update, polling fallback)
   ArkadeSwaps.createLightningInvoice)       │  onSwapUpdate → claimable (transaction.mempool)
                                             ▼
                                      ntfy.sh topic ──▶ 📱 your phone
```

- **Per-payment, opt-in registration.** Each time the wallet creates an invoice it
  registers that one reverse swap. Nothing is monitored wallet-wide — more private
  and a natural fit for Lightning's interactive invoice flow.
- **Monitor-only.** The service runs `SwapManager` with `enableAutoActions: false`,
  so it needs **no wallet keys** — it only watches. The wallet keeps the preimage and
  claims the swap itself; the registered swap can have its `preimage` redacted.
- **Push delivery:** pluggable `Notifier` interface; ships with three providers —
  [`ntfy.sh`](https://ntfy.sh) (no account/keys — install the app, subscribe to a
  topic), [BlueWallet GroundControl](https://github.com/BlueWallet/GroundControl)
  (FCM/APNS), and the **W3C Web Push API** for PWAs (VAPID-signed, delivered through
  a service worker even with the tab closed). Swap in FCM / Expo directly later.

### Key modules

| file | responsibility |
|------|----------------|
| `src/swapWatcher.ts` | builds the `@arkade-os/boltz-swap` `SwapManager` (monitor-only) |
| `src/paymentService.ts` | wires `SwapManager` events → push when claimable (via `isReverseClaimableStatus`); prunes on delivery/terminal |
| `src/registry.ts` | persisted `swapId → {topic\|subscription, swap}` map; resubscribed on restart |
| `src/notifier/ntfyNotifier.ts` | `Notifier` implementation for ntfy.sh |
| `src/notifier/webPushNotifier.ts` | `Notifier` implementation for the W3C Web Push API (PWAs), signed with VAPID |
| `src/server.ts` | HTTP API |
| `scripts/demo-receive.ts` | wallet side: creates an invoice via `ArkadeSwaps` and registers it |

## Setup

```bash
pnpm install
cp .env.example .env   # defaults target the Arkade mutinynet deployment
```

| var | default | meaning |
|-----|---------|---------|
| `NETWORK` | `mutinynet` | Arkade network (`NetworkName`) |
| `BOLTZ_API_URL` | `https://api.boltz.mutinynet.arkade.sh` | Boltz REST base; ws is derived from it |
| `ARK_SERVER_URL` | `https://mutinynet.arkade.sh` | Arkade server (demo script only) |
| `PORT` | `3000` | HTTP port |
| `NTFY_BASE_URL` | `https://ntfy.sh` | ntfy provider base URL |
| `GROUNDCONTROL_BASE_URL` | — | GroundControl provider base URL |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | — | Web Push (VAPID) credentials; all three enable Web Push |

Set **exactly one** provider: `NTFY_BASE_URL`, `GROUNDCONTROL_BASE_URL`, or the
three `VAPID_*` vars. Generate a VAPID key pair with `pnpm gen:vapid`.

## Run

```bash
pnpm dev      # watch mode (tsx)
# or
pnpm build && pnpm start
```

## HTTP API

| method | path | body | purpose |
|--------|------|------|---------|
| `POST` | `/register` | `{ swap, topic \| subscription, label? }` | watch a reverse swap (`swap` = the `pendingSwap` from `createLightningInvoice`). Provide **exactly one** of `topic` (ntfy/GroundControl) or `subscription` (a Web Push `PushSubscription`) |
| `GET` | `/register` | — | list registrations |
| `DELETE` | `/register/:swapId` | — | stop watching |
| `GET` | `/health` | — | status, ws connectivity, monitored count |
| `GET` | `/vapidPublicKey` | — | the VAPID public key for a PWA to subscribe with (404 when Web Push isn't configured) |
| `POST` | `/simulate` | `{ swapId, status }` | inject a status update for a registered swap (manual testing) |

## Try it end-to-end

1. For local testing, install the **ntfy** app on your phone and subscribe to a unique
   topic, e.g. `arkade-demo-7f3a` (ntfy needs no account/keys). The production provider
   is [BlueWallet GroundControl](https://github.com/BlueWallet/GroundControl), or Web
   Push for PWAs (see below); set exactly one provider.
2. Start the service: `pnpm dev`.
3. **Quick push smoke test** (no payment needed) — register a swap, then simulate Boltz
   funding it (`transaction.mempool`):
   ```bash
   curl -X POST localhost:3000/register -H 'content-type: application/json' \
     -d '{"topic":"arkade-demo-7f3a","swap":{"id":"demo","type":"reverse","status":"swap.created"}}'
   curl -X POST localhost:3000/simulate -H 'content-type: application/json' \
     -d '{"swapId":"demo","status":"transaction.mempool"}'
   ```
   Your phone should buzz with "Payment received ⚡".
4. **Full flow** against mutinynet — create a real invoice and pay it:
   ```bash
   pnpm demo -- --topic arkade-demo-7f3a --amount 1000
   ```
   The demo uses `ArkadeSwaps.createLightningInvoice` to mint a BOLT11 invoice, prints
   it, and registers the (preimage-redacted) pending swap. Pay the invoice from any
   mutinynet Lightning wallet → `SwapManager` sees `transaction.mempool` (funded) →
   push fires. (Requires connectivity to the Arkade mutinynet server + Boltz.)

## Web Push (PWAs)

To wake a **Progressive Web App** instead of a native app, use the Web Push
provider. It signs each push with VAPID and encrypts the payload end-to-end; the
browser delivers it to the PWA's service worker, which shows the notification —
even when no tab is open.

1. Generate a key pair and configure the service (comment `NTFY_BASE_URL` out):
   ```bash
   pnpm gen:vapid   # prints VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
   ```
2. In the PWA, register a service worker, fetch the public key, and subscribe. Then
   register that subscription per invoice — with the same `swap` you'd pass otherwise:
   ```js
   const { publicKey } = await (await fetch("/vapidPublicKey")).json();
   const reg = await navigator.serviceWorker.register("/sw.js");
   const subscription = await reg.pushManager.subscribe({
     userVisibleOnly: true,
     applicationServerKey: publicKey, // base64url; convert to Uint8Array if your browser needs it
   });
   await fetch("/register", {
     method: "POST",
     headers: { "content-type": "application/json" },
     body: JSON.stringify({ swap, subscription, label: "1000 sats" }),
   });
   ```
3. The service worker turns the pushed JSON (`{ title, body, amtPaidSat, ... }`) into
   a notification:
   ```js
   self.addEventListener("push", (event) => {
     const data = event.data.json();
     event.waitUntil(self.registration.showNotification(data.title, { body: data.body }));
   });
   ```

When Boltz funds the swap, the service pushes to the subscription's endpoint and the
PWA buzzes — same claimable-stage wake-up as the other providers.

## Tests

```bash
pnpm test
```

- `test/registry.test.ts` — registration persistence/reload and no-op write skipping.
- `test/paymentFlow.test.ts` — a **component test that drives the real
  `@arkade-os/boltz-swap` `SwapManager`** with a mocked `globalThis.WebSocket`,
  feeding mocked Boltz `swap.update` events through the whole pipeline: register →
  subscribe → `transaction.mempool` (exactly one push) → swap pruned. Also covers the
  `mempool → confirmed` de-duplication, terminal/failure pruning, and the `/simulate`
  path.
- `test/deliveryRetry.test.ts` — proves a transient `notify` failure is **not**
  lost: the reconciliation sweep redelivers a claimable-but-undelivered swap and then
  prunes it.
- `test/webPushNotifier.test.ts` — the Web Push notifier: VAPID setup, JSON payload,
  priority→urgency mapping, and mapping a `410 Gone` from the push service to an error.
  `test/paymentFlow.test.ts` also covers registering a `subscription`, the
  topic/subscription mutual exclusion, and `GET /vapidPublicKey`.

## Reliability

- **Never lose the wake-up.** Delivery is retried with backoff, and a periodic
  reconciliation sweep re-attempts any swap that is claimable but still registered —
  so a transient push-provider outage (or becoming claimable while the process was
  down) is recovered, not dropped. A synchronous in-flight guard prevents a
  re-entrant event (`mempool → confirmed`) from double-sending.
- **Bounded state.** A delivered swap, or one that reaches a terminal state
  (settled/failed/expired) without us pushing, is pruned from both the registry and
  the manager, so the persisted store stays small.
- **Crash-safe persistence.** The registry writes to a temp file then `rename()`s,
  so a crash mid-write can't corrupt `registrations.json`.

## Notes & extension points

- Because monitoring needs no keys, the wallet can **redact the `preimage`** before
  registering — the secret never leaves the wallet. The demo does this.
- ntfy, GroundControl and Web Push all sit behind the same `Notifier` interface; an
  `FcmNotifier` / `ExpoNotifier` can be added the same way, without touching the monitor.
- For a non-Boltz / wallet-wide path, the same idea maps onto the arkd indexer stream
  (`@arkade-os/sdk` `waitForIncomingFunds` / `SubscribeForScripts`); out of scope here.
