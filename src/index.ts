import { config } from "./config.js";
import { logger } from "./logger.js";
import { createStore } from "./store/index.js";
import { createSwapWatcher } from "./swapWatcher.js";
import { createNotifier } from "./notifierFactory.js";
import { attachPaymentNotifications } from "./paymentService.js";
import { WebSocket } from "ws";

async function main(): Promise<void> {
  // Boltz's SwapManager uses the global WebSocket, which Node < 22 lacks. Wire in
  // the `ws` implementation so real-time monitoring works on Node 20 too; without
  // it the manager silently degrades to slower polling.
  if (typeof globalThis.WebSocket === "undefined") {
    (globalThis as Record<string, unknown>).WebSocket = WebSocket;
  }

  const registry = createStore(config, logger);
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
  const app = buildServer({ registry, manager, simulate: payments.onSwapUpdate, logger });
  await app.listen({ host: "0.0.0.0", port: config.PORT });
  logger.info({ port: config.PORT, network: config.NETWORK }, "service listening");

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    payments.stop();
    await manager.stop();
    await app.close();
    registry.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
