import { config } from "./config.js";
import { logger } from "./logger.js";
import { Registry } from "./registry.js";
import { createSwapWatcher } from "./swapWatcher.js";
import { createNotifier } from "./notifierFactory.js";
import { attachPaymentNotifications } from "./paymentService.js";

async function main(): Promise<void> {
  const registry = new Registry(config.DATA_FILE, logger);
  registry.load();

  const manager = createSwapWatcher(
    { network: config.NETWORK, apiUrl: config.BOLTZ_API_URL, pollIntervalMs: config.POLL_INTERVAL_MS },
    logger,
  );
  const notifier = createNotifier();

  const payments = await attachPaymentNotifications({ manager, registry, notifier, logger });

  // Resume monitoring everything we were watching before a restart.
  const pending = registry.all().map((r) => r.swap);
  await manager.start(pending);
  logger.info({ resumed: pending.length }, "SwapManager started");

  const { buildServer } = await import("./server.js");
  const provider = config.provider;
  const app = buildServer({
    registry,
    manager,
    simulate: payments.onSwapUpdate,
    logger,
    targetKind: notifier.targetKind,
    vapidPublicKey: provider.kind === "webpush" ? provider.vapid.publicKey : undefined,
  });
  await app.listen({ host: "0.0.0.0", port: config.PORT });
  logger.info({ port: config.PORT, network: config.NETWORK }, "service listening");

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    payments.stop();
    await manager.stop();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
