import type { Logger } from "../logger.js";
import type { Notifier, NotifyPayload, NotifyTarget } from "./types.js";

const PRIORITY_MAP: Record<NonNullable<NotifyPayload["priority"]>, string> = {
  min: "1",
  low: "2",
  default: "3",
  high: "4",
  max: "5",
};

/**
 * Sends a push by POSTing to an ntfy server (https://ntfy.sh by default).
 * Install the ntfy app on the phone and subscribe to a topic; that topic is the
 * NotifyTarget. No account or API key required.
 */
export class NtfyNotifier implements Notifier {
  constructor(
    private readonly baseUrl: string,
    private readonly logger: Logger,
  ) {}

  async notify(target: NotifyTarget, payload: NotifyPayload): Promise<void> {
    if (!target.topic) throw new Error("NtfyNotifier requires target.topic");
    const url = `${this.baseUrl.replace(/\/$/, "")}/${encodeURIComponent(target.topic)}`;
    // HTTP header values are Latin-1; emit the (possibly UTF-8/emoji) title as raw
    // UTF-8 bytes mapped into a Latin-1 string. ntfy decodes header bytes as UTF-8.
    const headers: Record<string, string> = {
      Title: Buffer.from(payload.title, "utf8").toString("latin1"),
    };
    if (payload.tags?.length) headers["Tags"] = payload.tags.join(",");
    if (payload.priority) headers["Priority"] = PRIORITY_MAP[payload.priority];

    const res = await fetch(url, { method: "POST", headers, body: payload.body });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ntfy push failed: ${res.status} ${res.statusText} ${text}`.trim());
    }
    this.logger.info({ topic: target.topic, title: payload.title }, "push sent");
  }
}
