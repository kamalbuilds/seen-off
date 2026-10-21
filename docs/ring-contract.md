# Ring contract: webhook budget, retries and media

How Outbox meets the Ring Partner API's delivery contract. Every row names the code that enforces it and the test that fails if it stops.

| Ring requirement | Outbox behaviour | Code | Test |
|---|---|---|---|
| Acknowledge a delivery within 5 s | The receiver answers inside a 4 s internal budget. Past it, `503 ack_budget_exceeded` so Ring retries. | `src/ring/webhook.ts` | `webhook: a handler slower than the ack budget gets 503` |
| `X-Signature` is HMAC-SHA256 over the raw bytes | Verified over the bytes as received, before parsing, in constant time. Missing, malformed, re-serialised and wrong-key signatures are `401`. | `src/ring/signature.ts` | `signature: valid, tampered, wrong key, missing, malformed header` |
| Deliveries are retried and can repeat | `meta.request_id` is marked processed only after the handler succeeds. A repeat is `200 already_processed`; a failed first attempt is processed on Ring's retry. 50 concurrent copies run the handler once. | `src/ring/webhook.ts`, `src/store/ledger.ts` | `webhook: handler throws, Ring retries`, `webhook: 50 concurrent deliveries` |
| Do the work off the request path | The handler only records the event. Vision runs later in `runner.drain()`, after a settle delay, on a stored queue that survives a restart. | `src/server.ts`, `src/pickup/runner.ts` | `packet timeline`, `restart mid-window` |
| Events belong to a device | A motion event is matched to open pickup days by device id and window; another doorbell's event is consumed and ignored. | `src/store/ledger.ts` | `a motion event from another doorbell ... triggers no frame` |
| Snapshots can answer `RECORDING_NOT_READY` (425) or `SERVER_BUSY` (503) | Retried with a growing wait; `MEDIA_NOT_FOUND` (416) and 403 are not retried. If the snapshot source fails, the WHEP live frame is tried next. | `src/ring/client.ts`, `src/pickup/runner.ts` | `snapshot errors`, `frame sources are tried in order` |
| Refresh tokens rotate on every exchange | Each rotated token is written to a 0600 file by atomic rename and used after a restart. | `src/ring/token-store.ts` | `a rotated refresh token is saved 0600` |
| WHEP sessions must be closed | The worker `DELETE`s the session after the frame grab so a battery camera stops streaming. | `worker/whep_frame.py` | `npm run test:whep` |

Measured against the 100-delivery load run in `metric/run.ts`: ack p95 1 ms, max 2 ms; 100/100 duplicates acknowledged without reprocessing; 10/10 forged bodies `401`.
