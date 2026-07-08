import Fastify from "fastify";
import { z } from "zod";
import type { BoltzReverseSwap, BoltzSwapStatus, SwapManagerClient } from "@arkade-os/boltz-swap";
import type { Logger } from "./logger.js";
import type { Registry } from "./registry.js";
import type { NotifyTarget, NotifyTargetKind, WebPushSubscription } from "./notifier/types.js";

/**
 * A reverse swap as handed over by the wallet. Validated loosely: we only require
 * the fields the SwapManager needs to monitor it (id, reverse discriminator,
 * status). `preimage` may be redacted by the wallet since we never claim.
 */
const reverseSwapSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("reverse"),
    status: z.string().min(1),
    createdAt: z.number().optional(),
    preimage: z.string().optional(),
    request: z.unknown().optional(),
    response: z.unknown().optional(),
  })
  .passthrough();

/**
 * A W3C Push API subscription (`subscription.toJSON()`) for Web Push delivery.
 * Anchored to the `web-push` library's type so schema and type can't drift.
 * (The browser also emits `expirationTime`; it's optional, unused, and stripped.)
 */
const webPushSubscriptionSchema: z.ZodType<WebPushSubscription> = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

// A registration must carry exactly one delivery target: a `topic` (ntfy /
// GroundControl) or a Web Push `subscription`.
const registerSchema = z
  .object({
    topic: z.string().min(1).optional(),
    subscription: webPushSubscriptionSchema.optional(),
    label: z.string().optional(),
    swap: reverseSwapSchema,
  })
  .refine((d) => Boolean(d.topic) !== Boolean(d.subscription), {
    message: "provide exactly one of `topic` or `subscription`",
  });

export interface ServerDeps {
  registry: Registry;
  manager: SwapManagerClient;
  /** Inject a synthetic swap update through the same pipeline (for manual testing). */
  simulate: (swap: BoltzReverseSwap, oldStatus: BoltzSwapStatus) => void;
  logger: Logger;
  /** Target kind the configured notifier can deliver to; /register rejects the rest. */
  targetKind: NotifyTargetKind;
  /** VAPID public key, exposed at `GET /vapidPublicKey` so a PWA can subscribe. */
  vapidPublicKey?: string;
}

export function buildServer(deps: ServerDeps) {
  const { registry, manager, simulate, logger, targetKind, vapidPublicKey } = deps;
  const app = Fastify({ loggerInstance: logger });

  // A PWA fetches this to call `PushManager.subscribe({ applicationServerKey })`,
  // then posts the resulting subscription to `/register`. 404 when Web Push is off.
  app.get("/vapidPublicKey", (_request, reply) => {
    if (!vapidPublicKey) return reply.code(404).send({ error: "web push not configured" });
    return reply.send({ publicKey: vapidPublicKey });
  });

  app.get("/health", async () => {
    const stats = await manager.getStats();
    return {
      status: "ok",
      wsConnected: stats.websocketConnected,
      monitoredSwaps: stats.monitoredSwaps,
      usePollingFallback: stats.usePollingFallback,
      registrations: registry.all().length,
    };
  });

  // Opt-in, per-payment registration: the wallet posts each invoice's reverse swap.
  app.post("/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid body", issues: parsed.error.issues });
    }
    const target: NotifyTarget = parsed.data.topic
      ? { kind: "topic", topic: parsed.data.topic }
      : { kind: "webpush", subscription: parsed.data.subscription! };
    // Reject a target the configured provider can't address — accepting it
    // would 201 a registration whose push can never be delivered.
    if (target.kind !== targetKind) {
      const field: Record<NotifyTargetKind, string> = { topic: "topic", webpush: "subscription" };
      return reply.code(400).send({
        error: `the configured push provider needs a \`${field[targetKind]}\` target, got \`${field[target.kind]}\``,
      });
    }
    const swap = parsed.data.swap as unknown as BoltzReverseSwap;
    // Subscribe first: if the manager rejects, nothing is persisted, so the
    // registry never holds a swap that isn't actually being monitored.
    await manager.addSwap(swap);
    const reg = registry.add({ swap, target, label: parsed.data.label });
    return reply.code(201).send({ ok: true, registration: reg });
  });

  app.get("/register", () => ({ registrations: registry.all() }));

  app.delete<{ Params: { swapId: string } }>("/register/:swapId", async (request, reply) => {
    const { swapId } = request.params;
    // Remove from the registry first (the source of truth for resubscription);
    // best-effort unsubscribe from the manager so a manager error can't strand
    // the entry in the registry.
    const removed = registry.remove(swapId);
    await manager
      .removeSwap(swapId)
      .catch((err) => logger.warn({ err, swapId }, "manager.removeSwap failed"));
    return reply.code(removed ? 200 : 404).send({ ok: removed });
  });

  // Manual testing helper: pretend a status update arrived for a registered swap.
  //   curl -X POST localhost:3000/simulate -d '{"swapId":"x","status":"invoice.settled"}'
  app.post("/simulate", (request, reply) => {
    const parsed = z
      .object({ swapId: z.string().min(1), status: z.string().min(1) })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid body", issues: parsed.error.issues });
    }
    const reg = registry.get(parsed.data.swapId);
    if (!reg) return reply.code(404).send({ error: "unknown swapId" });
    const oldStatus = reg.swap.status;
    const swap: BoltzReverseSwap = { ...reg.swap, status: parsed.data.status as BoltzSwapStatus };
    simulate(swap, oldStatus);
    return reply.send({ ok: true });
  });

  return app;
}
