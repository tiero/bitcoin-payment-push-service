import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { JsonStore } from "./jsonStore.js";
import { SqliteStore } from "./sqliteStore.js";
import type { RegistrationStore } from "./types.js";

export type { Registration, RegisterInput, RegistrationStore } from "./types.js";
export { JsonStore } from "./jsonStore.js";
export { SqliteStore } from "./sqliteStore.js";

/** Builds the registration store selected by `STORAGE_BACKEND` (json | sqlite). */
export function createStore(config: Config, logger: Logger): RegistrationStore {
  switch (config.STORAGE_BACKEND) {
    case "sqlite":
      return new SqliteStore(config.DATA_FILE, logger);
    case "json":
    default:
      return new JsonStore(config.DATA_FILE, logger);
  }
}
