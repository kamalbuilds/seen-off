# Outbox

Carrier-pickup proof for people who ship from home, built on the Ring Partner API.

A seller leaves parcels on the porch for a scheduled USPS or UPS pickup. Outbox watches the porch through the Ring doorbell, reconciles it against that day's Shippo labels and the carrier's tracking, and gives one verdict per pickup day:

| Verdict | Meaning | What the seller gets |
|---|---|---|
| taken | every parcel left the porch and every label shows a carrier scan | nothing to do |
| missed | the parcels are still on the porch when the window closes | an alert with the parcel count while there is time to drop them off |
| part-taken | some parcels left, some did not | an alert: "1 of 3 parcels taken, 2 still on the porch" |
| unscanned | the parcels left the porch but a label still shows no carrier scan 24 h later | an evidence packet: Ring-watermarked frames, handoff time, label list, tracking status |

When a frame cannot be read, the seller is alerted to check the Ring app. Outbox never reports a pickup it did not see.

## Ring surfaces called

| Surface | Code |
|---|---|
| OAuth refresh-token grant (token rotation handled) or Playground token | `src/ring/client.ts` |
| `GET /v1/devices?include=status,capabilities,configurations` | `RingClient.listDevices` |
| `POST /v1/devices/{id}/media/image/download` (303 to the signed URL) | `RingClient.snapshotAt`, `RingSnapshotSource` (retries `RECORDING_NOT_READY`) |
| `GET /v1/history/devices/{id}/events?event_types=` with `links.next` paging | `RingClient.history` |
| WHEP live view: recvonly offer, `201` + SDP answer, `DELETE` the session, sharpest of N frames | `worker/whep_frame.py` (aiortc), `src/ring/whep.ts` |
| v1.1 webhook: `X-Signature` HMAC-SHA256 over the raw bytes, 5 s ack, `meta.request_id` idempotency | `src/ring/webhook.ts`, `src/ring/signature.ts` |

Webhook handling follows the Ring reference exactly. The signature is checked over the bytes as received, before parsing. A delivery is acknowledged inside the 5 s budget (4 s internal cap, then `503` so Ring retries). The `request_id` is marked processed only after the handler succeeds, so a failed delivery that Ring retries is processed, not swallowed.

## Pipeline

```
Ring webhook (motion_detected / button_press)
  -> verify X-Signature, record event, ack            src/server.ts, src/ring/webhook.ts
  -> settle delay, then a snapshot (WHEP as fallback)  src/pickup/runner.ts
  -> vision stage: parcels present, how many           src/vision (Qwen3-VL on Amazon Bedrock behind a provider interface)
  -> ledger (SQLite): baseline, motion, close counts   src/store/ledger.ts
  -> window-close verdict, 24 h tracking verdict       src/pickup/verdict.ts
  -> alert + evidence packet                           GET /days/:id
```

Shippo (`src/shippo/client.ts`): labels (`/shipments/` then `/transactions/`, accepted only on a `SUCCESS` transaction), tracking (`GET /tracks/{carrier}/{number}`, test mode with `SHIPPO_PRE_TRANSIT`, `SHIPPO_TRANSIT`, `SHIPPO_DELIVERED`), pickup rescheduling (`/pickups/`).

The vision stage is a one-method interface (`src/vision/types.ts`). With `AWS_BEARER_TOKEN_BEDROCK` set, the vision stage is Amazon Bedrock by default: `qwen.qwen3-vl-235b-a22b-instruct` through the Bedrock OpenAI-compatible endpoint (`bedrock-mantle.us-east-1.api.aws/v1`), frame sent as a data URL (`src/vision/bedrock-mantle.ts`). `VISION_PROVIDER=openrouter` calls `amazon/nova-lite-v1` through OpenRouter; `VISION_PROVIDER=bedrock` calls Nova Lite through Bedrock Converse.

## Measured

Every number below is reproducible from this repo. The two must-fail rows show the checks can go red.

**Is a parcel on the porch?** 60 Ring-watermarked doorbell-angle frames, 30 present and 30 gone, labels committed before any model call (`spikes/porch`).

| Run | Result |
|---|---|
| Bedrock Qwen3-VL, present or gone | 59/60 = 98.3% (real footage 35/35, median 1.33 s per frame) |
| Bedrock Qwen3-VL, parcel count exact | 49/53 = 92.5% |
| Nova Lite via OpenRouter, present or gone | 58/60 = 96.7% (real footage 35/35) |
| Nova Lite via OpenRouter, parcel count exact | 49/53 = 92.5% |
| Must-fail: always answers "present" | 30/60 = 50.0% |
| Must-fail: parcels painted out of 10 frames the model had read as present | 10/10 flip to "gone" on Bedrock Qwen3-VL and on Nova Lite |

Frames: two real fixed-camera doorstep clips from Wikimedia Commons (CC BY 3.0, `spikes/porch/ATTRIBUTION.md`), parcel cut-outs composited onto their empty backgrounds, exposure and infrared-style variants. The Ring watermark follows the Computer Vision Guidelines: wordmark top-left, device id, app name and timestamp top-right, fixed pixel size.

`node spikes/porch/run.ts main` (Bedrock by default when `AWS_BEARER_TOKEN_BEDROCK` is set)

**Does the verdict match the day?** 30 replayed pickup days: 10 taken, 10 missed, 5 part-taken, 5 taken but unscanned. Webhooks are signed by a simulator that follows the Ring v1.1 envelope and HMAC rules; the receiver, runner, ledger and vision stage are the production code (`metric/run.ts`).

| Run | Correct verdicts |
|---|---|
| Bedrock Qwen3-VL | 25/30 (taken 10/10, missed 7/10, part-taken 4/5, unscanned 4/5), both counts exact on 22/30 days |
| Nova Lite via OpenRouter | 23/30 (taken 8/10, missed 7/10, part-taken 4/5, unscanned 4/5), both counts exact on 19/30 days |
| Must-fail: vision always answers "1 parcel present" | 10/30 (every day becomes "missed") |
| Must-fail: verdict logic mutated so a missed day reads as taken | 17/30 (missed 0/10) |

Missed-pickup alert on Bedrock Qwen3-VL: median 2.2 s from window close, max 3.0 s (Nova Lite via OpenRouter: median 1.3 s, max 2.0 s). Webhook ack over 100 signed deliveries: p95 1 ms, max 1 ms, 100/100 duplicates acknowledged without reprocessing, 10/10 forged bodies answered `401`.

`node metric/run.ts`, and `node metric/run.ts --always-present` for the always-present row.

## Run it

```
npm test                  # 33 tests, one of them a live Bedrock read of a porch frame: signature, receiver, verdicts, runner, Ring client, Shippo, HTTP server
npm run test:whep         # WHEP worker against a local WHEP server serving a real frame
npm run mutation          # breaks the signature check, the idempotency order and the verdict logic, expects red each time
cp .env.example .env      # names only; fill values yourself
npm run ring:probe devices
npm run serve
```

Requirements: Node 24 (type stripping, `node:sqlite`, `node:test`), no npm dependencies. The WHEP worker needs Python 3.12 with `worker/requirements.txt`; the frame builders need `requirements.txt`.

## Content policy

No face recognition and no reading of plates or labels against outside data. Evidence frames are written to a local directory the operator controls. Nothing is child-directed.

## License

MIT
