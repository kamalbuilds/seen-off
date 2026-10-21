// Prints exactly what to enter in the Ring Developer Portal for this server, from OUTBOX_PUBLIC_URL, and what to put in .env.
//   OUTBOX_PUBLIC_URL=https://outbox.example.com npm run ring:setup
import { consoleSettings } from "../src/ring/integration.ts";

const c = consoleSettings(process.env.OUTBOX_PUBLIC_URL);
if (!c) {
  console.error("Set OUTBOX_PUBLIC_URL to this server's public https address (for example https://outbox.example.com), then run this again.");
  process.exit(2);
}
console.log(`Ring Developer Portal, your app, Account linking:
  Account Link URL     ${c.accountLinkUrl}
  Token Exchange URL   ${c.tokenExchangeUrl}
  App Homepage URL     ${c.appHomepageUrl}
  Webhook URL          ${c.webhookUrl}
Ring Developer Portal, API scopes:
  ${c.scopes}
Partner-initiated apps only (allowlisted): OAuth Redirect URI  ${c.oauthRedirectUri}

.env on this server (values come from the credentials Ring shows once when the app is created):
  RING_CLIENT_ID=            Client ID
  RING_CLIENT_SECRET=        Client Secret
  RING_WEBHOOK_SIGNING_KEY=  HMAC Signature Key
  OUTBOX_SIGN_IN_CODE=       a code you choose; you type it when Ring sends you to the sign-in page
  OUTBOX_PUBLIC_URL=         ${process.env.OUTBOX_PUBLIC_URL}`);
