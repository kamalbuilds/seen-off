# Friction log: Ring Partner API, Playground and sample app

Task context: Seen Off, a carrier-pickup proof app built on the Ring Partner API and Amazon Bedrock. Sources: the Ring API documentation (`developer.amazon.com/docs/ring/api-documentation.html`), the Ring Developer Playground release notes (May 28 2026), Devpost forum topics 45309, 45511 and 45541, `AmazonAppDev/ring-api-helloworld` at `76100aa`, and this repo's history.

### 1. The Playground emits no webhooks, and every live-view scenario writes the same record

- Task: exercise the v1.1 webhook path (`motion_detected`, `button_press`) end to end from the Ring Developer Playground.
- Steps: open the Playground, press each of the three scenario buttons (Package, Vehicle, Motion), then read `GET /v1/history/devices/{id}/events` and watch the registered webhook URL. Devpost forum topics 45309 and 45511 report the same behaviour and Amazon staff confirm it.
- Expected: a scenario named "Motion" produces a `motion_detected` delivery with a `sub_type`, and history shows the matching event.
- Actual: all three buttons write `event_type: "on_demand"` with `cv_detections: { data: [] }` and no `sub_type`. No webhook is delivered. Staff reply on 45309: "the Playground simulates live view sessions, not motion webhooks, so it cannot exercise that path". The button labels name the simulated scenario, not the resulting event type.
- Severity: High. The path a partner app is built around, event-driven triggers, cannot be exercised in the sandbox.
- Workaround: a signed v1.1 webhook simulator (`simulator/webhook-simulator.ts`) that sends HMAC-signed `motion_detected` deliveries to the production receiver. Staff on 45511: "Using your own simulator is fine because you're still using a substantial amount of the actual Ring tech".
- Suggestion: let the Playground fire real signed v1.1 deliveries to a registered webhook URL, with `sub_type` values (`human`, `vehicle`, `package_delivery`, `other_motion`) chosen per button, and write the matching `motion.*` record to history. Rename the buttons to the event they produce.

### 2. The Playground token lasts 30 minutes and carries no refresh token

- Task: run a capture or a long test cycle against the Playground API (`GET /v1/devices`, image download, WHEP live view).
- Steps: read the Playground release notes and Devpost forum topic 45541 on the token, then design the client's credentials for a session that runs past 30 minutes.
- Expected: either a refresh token to renew it, or a visible expiry on the token screen.
- Actual: per the release notes and topic 45541 ("30-minute tokens, no refresh"), the token is valid for 30 minutes. There is no refresh token, so a new session needs a trip back to the Amazon sign-in for a fresh token. The OAuth refresh-token grant (about 30 day refresh token, about 4 h access token) exists only for a registered app with a linked account.
- Severity: Medium for short spikes, High for any scripted or CI test of the client.
- Workaround: the client treats the Playground token and the refresh-token grant as two credential modes (`src/ring/client.ts`), and `npm run ring:preflight` reports each failing surface with Ring's own status.
- Suggestion: issue a refresh token with the Playground token, or allow a longer Playground token for CLI use. Show the expiry time next to the token.

### 3. Every Ring call must be server to server, including the WHEP SDP exchange

- Task: show a live view in the seller page.
- Steps: read the API documentation and the `app/api/ring/stream/route.ts` proxy in `ring-api-helloworld`, then design the live-view path.
- Expected: a browser WebRTC client posts its SDP offer to the WHEP endpoint.
- Actual: browser calls are blocked by CORS. The SDP exchange has to be proxied by a backend (the same shape as `app/api/ring/stream/route.ts` in `ring-api-helloworld`), and a Node server needs a WebRTC stack to pull frames.
- Severity: Medium.
- Workaround: a Python `aiortc` worker (`worker/whep_frame.py`) opens the session server-side, grabs the sharpest of N frames and always `DELETE`s the session so a battery camera stops streaming; `src/ring/whep.ts` calls it. A loopback test (`npm run test:whep`) serves a real frame to the worker.
- Suggestion: say so on the live-video page next to the example, and ship a small server-side WHEP frame-grab sample (Node or Python) so partners need not discover the WebRTC dependency themselves.

### 4. Chimes and sensors are Early Access

- Task: add an audible nudge on the doorbell chime when a pickup is missed.
- Steps: read the Chimes section (scope "Chime Controls"), then Devpost forum topic 45309, which reports `audio.customizable_slots` for the Playground DoorbellPro from `GET /v1/devices?include=capabilities,configurations`.
- Expected: the only write action in the API (`POST /v1/devices/{id}/media/audio/playback`) can be requested like the other scopes.
- Actual: Chimes and sensors sit behind the Ring Developer Early Access Program. Per topic 45309, the Playground DoorbellPro reports `audio.customizable_slots: null` (a real chime reports 2 slots and `chime.play`), which leaves nothing to play.
- Severity: Medium. The one output channel a notification app wants is not reachable.
- Workaround: alerts leave through an alert webhook and a file channel (`src/alerts.ts`).
- Suggestion: a Playground chime with two slots and `chime.play`, so the write path can be built and tested before Early Access is granted.

### 5. Partner-initiated OAuth with PKCE is invitation-only

- Task: link a seller's Ring account from the app's own "Connect Ring" button.
- Steps: build the documented authorize URL (`account.ring.com/account/integrations/partner-link/authorize`, scope `ava.v1:read`, PKCE S256), exchange the code at `oauth.ring.com`, confirm with `PATCH /v1/accounts/me/app-integrations`.
- Expected: the most natural flow for a web app is open to a registered app.
- Actual: the Authentication page states this method is available by invitation only (allowlisted app). A normal registered app uses the one-way, Ring-driven link: Ring pushes a single-use code to the Token Exchange URL (exchange within 60 s), then redirects the seller to the Account Link URL with `nonce` and `time`; the partner recomputes `HMAC-SHA256(key, "<time>:<account_id>")`, authenticates its own user, then does POST then PATCH to confirm.
- Severity: Medium. Two full link flows had to be built, and the docs lead with the one most apps cannot use.
- Workaround: both are implemented. One-way is the default (`src/ring/oneway.ts`); `RING_LINK_METHOD=partner-initiated` keeps the allowlisted path (`src/ring/oauth.ts`).
- Suggestion: open the Authentication page with a decision table (registered app: one-way; allowlisted: partner-initiated), and add a request-allowlisting link for hackathon entrants.

### 6. The `ring-api-helloworld` webhook route authenticates with a Bearer token, not `X-Signature`

- Task: protect `/api/webhook` the way Ring delivers.
- Steps: read `app/api/webhook/route.ts` against the Notifications section of the API documentation.
- Expected: `X-Signature: sha256=<hex>`, HMAC-SHA256 of the raw body bytes with the signing key, constant-time compare, 401 on failure, verified before parsing.
- Actual: the sample checks `Authorization: Bearer $RING_WEBHOOK_SECRET`, which Ring never sends, skips auth entirely when the variable is unset, and `request.json()` discards the raw bytes the signature covers. Real Ring deliveries cannot authenticate against it.
- Severity: High (a spoofable endpoint in the sample partners copy).
- Workaround: Seen Off verifies over the raw bytes before parsing (`src/ring/signature.ts`); forged bodies answer `401` (10 of 10 in `metric/run.ts`).
- Suggestion: merge the open upstream signature PR (#31) and make the sample fail closed when the secret is unset.

### 7. The sample's schema is v1.0 and invents fields Ring never sends

- Task: parse Ring v1.1 webhooks with the sample's Zod schema.
- Steps: compare the schema to the v1.1 envelope and the ten documented event types.
- Expected: `meta.version` `1.1` with `meta.account_id`; `motion_detected`, `button_press`, `device_added`, `device_removed`, `device_online`, `device_offline`, `app_integration_added`, `app_integration_removed`, `subscription_activated`, `subscription_deactivated`; motion attributes `sub_type`, `timestamp_readable`, optional `component_ids`; no snapshot, confidence or bounding box.
- Actual: four event types including `person_detected`, which Ring does not send; `confidence`, `bounding_box` and `thumbnail_url` that Ring never sends; `button_press` and `device_offline` fall to the generic normalizer and show as `unknown`. The UI Person filter keys on `person_detected`, so it never matches real traffic (person detection in v1.1 is `motion_detected` with `sub_type: "human"`).
- Severity: Medium.
- Workaround: Seen Off reads `sub_type` and the documented fields only (`src/ring/webhook.ts`).
- Suggestion: model all ten types, drop the invented fields, key the Person filter on `sub_type`.

### 8. The sample records `request_id` before handling, so a retried failure is acknowledged and lost

- Task: survive Ring's retry after a handler failure.
- Steps: send a v1.1 payload whose `attributes.timestamp` is `1e20` (the schema accepts any number). `new Date(1e20).toISOString()` throws `RangeError`, the route answers 500, Ring retries with the same `request_id`.
- Expected: the docs say a 5xx is retried with backoff and the handler must be idempotent, so the retry runs the handler again.
- Actual: `processedRequests.add(requestId)` runs before normalizing and broadcasting, so the retry returns 200 `already_processed`. Ring marks it delivered and the event is never broadcast. Any transient failure loses the event the same way.
- Severity: High (silent data loss on the documented retry path).
- Workaround: Seen Off marks the id only after the handler succeeds, and 50 concurrent copies run the handler once (`src/ring/webhook.ts`, `docs/ring-contract.md`).
- Suggestion: fixed on branch `fix/webhook-idempotency` of the sample (duplicate check up front, id recorded after `broadcastEvent`). The repo's first test file, `tests/webhook-idempotency.test.cjs`, has 4 cases: 2 fail on unmodified `main`, all 4 pass on the branch, and moving the `add` back above the handler turns the same 2 red again.

### 9. Bedrock Nova answers "Operation not allowed" while the mantle endpoint serves Qwen3-VL

- Task: read a porch frame with a Bedrock vision model.
- Steps: call Amazon Nova through `bedrock-runtime` Converse from the account in `us-east-1` with a Bedrock API key; then call `qwen.qwen3-vl-235b-a22b-instruct` through `https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions` with the same key.
- Expected: the vision models listed for Bedrock answer on the same account and key.
- Actual: Nova on Converse returns `400` with "Operation not allowed". The mantle OpenAI-compatible endpoint answers Qwen3-VL with a data-URL image, and reads 59 of 60 porch frames correctly (median 1.33 s).
- Severity: Medium. Which models an account can call is only discoverable by trying them.
- Workaround: the vision stage is a one-method interface (`src/vision/types.ts`); the default with `AWS_BEARER_TOKEN_BEDROCK` set is `src/vision/bedrock-mantle.ts`, and `VISION_PROVIDER=bedrock` selects Nova Converse where an account allows it.
- Suggestion: make the error name the missing model access or the account-level block, and list the models a given API key can call.

### 10. The Ring Appstore catalogue is not visible outside the US

- Task: study the apps a new entry will be compared with.
- Steps: open `ring.com/appstore` from outside the US.
- Expected: the app list.
- Actual: the page reads "The Ring Appstore will be available outside the US soon" and shows no app list. The catalogue (Package Protect, QueueFlow, Minut, StoreTraffic) was only recoverable from press coverage and Ring's blog.
- Severity: Low to Medium.
- Workaround: read the Appstore descriptions from TechCrunch (2026-03-31) and Ring's blog.
- Suggestion: a read-only public catalogue page, so partners everywhere can check what already exists before building.
