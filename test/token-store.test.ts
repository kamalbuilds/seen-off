import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { RingClient, type RingAuth } from "../src/ring/client.ts";
import { loadRefreshToken, saveRefreshToken, withPersistedRefreshToken } from "../src/ring/token-store.ts";

const refresh = (t: string): RingAuth => ({ kind: "refresh", clientId: "c", clientSecret: "s", refreshToken: t });

test("a rotated refresh token is saved 0600 and the next process starts from it, not from .env", async () => {
  const seen: string[] = [];
  let n = 0;
  const srv = createServer(async (req, res) => {
    let b = ""; for await (const c of req) b += c;
    seen.push(new URLSearchParams(b).get("refresh_token")!);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: `a${++n}`, refresh_token: `rotated-${n}`, expires_in: 14400 }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const oauthBase = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const file = join(mkdtempSync(join(tmpdir(), "tok-")), "ring-refresh-token");
  try {
    assert.equal(loadRefreshToken(file), null, "nothing saved yet");
    const first = new RingClient({ auth: withPersistedRefreshToken(refresh("from-env"), file), oauthBase });
    await first.accessToken();
    assert.deepEqual(seen, ["from-env"]);
    assert.equal(readFileSync(file, "utf8").trim(), "rotated-1");
    assert.equal(statSync(file).mode & 0o777, 0o600);

    // a restart: .env still holds the original, now revoked, token
    const second = new RingClient({ auth: withPersistedRefreshToken(refresh("from-env"), file), oauthBase });
    await second.accessToken();
    assert.deepEqual(seen, ["from-env", "rotated-1"], "the saved token is used after restart");
    assert.equal(loadRefreshToken(file), "rotated-2");
  } finally { srv.close(); }
});

test("a Playground token is passed through untouched and no file is written", () => {
  const file = join(mkdtempSync(join(tmpdir(), "tok-")), "t");
  const a: RingAuth = { kind: "token", token: "pg" };
  assert.equal(withPersistedRefreshToken(a, file), a);
  saveRefreshToken(file, "x");
  assert.equal(loadRefreshToken(file), "x");
});
