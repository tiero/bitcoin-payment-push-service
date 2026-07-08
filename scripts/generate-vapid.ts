/**
 * Generates a VAPID key pair for Web Push and prints it as env vars.
 *
 *   pnpm gen:vapid
 *
 * Put the two keys in your `.env` (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY), keep
 * the private key secret, and hand the public key to the PWA (it's also served at
 * `GET /vapidPublicKey`). Set VAPID_SUBJECT to a `mailto:` or `https:` contact URI.
 */
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

process.stdout.write(
  [
    "# Web Push VAPID keys — add to .env (keep the private key secret)",
    `VAPID_PUBLIC_KEY=${publicKey}`,
    `VAPID_PRIVATE_KEY=${privateKey}`,
    "VAPID_SUBJECT=mailto:you@example.com",
    "",
  ].join("\n"),
);
