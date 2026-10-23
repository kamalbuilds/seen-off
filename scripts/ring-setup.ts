// Prints exactly what to enter in the Ring Developer Portal for this server, from SEEN_OFF_PUBLIC_URL, and what to put in .env.
//   SEEN_OFF_PUBLIC_URL=https://seenoff.example.com npm run ring:setup
import { consoleSettings, seenOffEnv } from "../src/ring/integration.ts";

const publicUrl = seenOffEnv(process.env, "PUBLIC_URL");
const c = consoleSettings(publicUrl);
if (!c) {
  console.error("Set SEEN_OFF_PUBLIC_URL to this server's public https address (for example https://seenoff.example.com), then run this again.");
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
  SEEN_OFF_SIGN_IN_CODE=       a code you choose; you type it when Ring sends you to the sign-in page
  SEEN_OFF_PUBLIC_URL=         ${publicUrl}`);
