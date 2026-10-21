#!/usr/bin/env bash
# Mutation gate: break the code a test guards, confirm the suite goes red, restore, confirm green.
# Each mutation is "file@@sed expression@@test file that must fail@@label". Runs against a temp copy, never the working tree.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0

# exit 0 only when the suite ran and every test passed; "red" below additionally requires a real test failure, not a crash.
run_suite() { (cd "$1" && node --test "test/$2" >"$TMP/out.txt" 2>&1); }
real_red() { grep -Eq "^ℹ fail [1-9]" "$TMP/out.txt"; }
fresh() { rm -rf "$TMP/w"; mkdir "$TMP/w"; (cd "$ROOT" && tar cf - --exclude=node_modules --exclude=.git --exclude=spikes --exclude=data --exclude=.venv src test simulator metric scripts package.json 2>/dev/null) | (cd "$TMP/w" && tar xf -); }

fresh
for t in webhook.test.ts verdict.test.ts packet.test.ts plan.test.ts scheduler.test.ts probe.test.ts replay-regressions.test.ts replay-api.test.ts token-store.test.ts runner.test.ts alerts.test.ts evidence.test.ts score.test.ts; do
  if run_suite "$TMP/w" "$t"; then echo "GREEN baseline $t"; else echo "BASELINE FAILS $t"; fail=1; fi
done

while IFS= read -r line; do
  [ -z "$line" ] && continue
  file="$(awk -F'@@' '{print $1}' <<<"$line")"; expr="$(awk -F'@@' '{print $2}' <<<"$line")"
  tfile="$(awk -F'@@' '{print $3}' <<<"$line")"; label="$(awk -F'@@' '{print $4}' <<<"$line")"
  fresh
  if ! sed -i.bak -E "$expr" "$TMP/w/$file"; then echo "MUTATION SED ERROR: $label"; fail=1; continue; fi
  if cmp -s "$TMP/w/$file" "$TMP/w/$file.bak"; then echo "MUTATION DID NOT APPLY: $label"; fail=1; continue; fi
  if run_suite "$TMP/w" "$tfile"; then echo "SURVIVED (check is blind) $label"; fail=1; elif real_red; then echo "RED   $label"; else echo "CRASHED, not a test failure: $label"; fail=1; fi
done <<'MUT'
src/ring/signature.ts@@s/return timingSafeEqual\(expected, Buffer.from\(received, "hex"\)\);/return true;/@@webhook.test.ts@@signature check always accepts
src/ring/signature.ts@@s/if \(!signingKey \|\| !header\) return false;//@@webhook.test.ts@@missing header no longer rejected
src/ring/webhook.ts@@s/\.then\(\(\) => opts\.handle\(event\)\)\s*$/.then(() => { opts.store.markDone(event.requestId); return opts.handle(event); })/@@webhook.test.ts@@idempotency marked before handling
src/ring/webhook.ts@@s/if \(opts\.store\.isDone\(event\.requestId\)\) return/if (false) return/@@webhook.test.ts@@duplicate request_id reprocessed
src/pickup/verdict.ts@@s/if \(c === b\) return \{ verdict: "missed"/if (c === b) return { verdict: "taken"/@@verdict.test.ts@@missed reported as taken
src/pickup/verdict.ts@@s/if \(c === 0\) return \{ verdict: "taken"/if (c <= 1) return { verdict: "taken"/@@verdict.test.ts@@partial collapsed into taken
src/pickup/verdict.ts@@s/ \|\| b <= 0\) return/) return/@@verdict.test.ts@@empty baseline no longer unverified
src/pickup/verdict.ts@@s/SCANNED.has\(t.status\)/true/@@verdict.test.ts@@unscanned never detected
src/provenance.ts@@s/ORDER.indexOf\(p\) > ORDER.indexOf\(w\)/ORDER.indexOf(p) < ORDER.indexOf(w)/@@packet.test.ts@@verdict provenance no longer the weakest input
src/provenance.ts@@s/SIMULATOR\|FIXTURE/NEVERMATCH/@@packet.test.ts@@simulated webhooks labelled live
src/pickup/runner.ts@@s/src\.provenance \?\? "simulated"/src.provenance ?? "live"/g@@packet.test.ts@@unlabelled frame source reads as live
src/pickup/plan.ts@@s/\(end as number\) <= \(start as number\)/false/@@plan.test.ts@@window may end before it starts
src/pickup/plan.ts@@s/\|\| labels.length === 0//@@plan.test.ts@@empty labels accepted
src/pickup/plan.ts@@s/\[A-Za-z0-9\._-\]/[A-Za-z0-9._\/-]/@@plan.test.ts@@dayId may contain a slash
src/pickup/verdict.ts@@s/n < 0\)/false)/@@plan.test.ts@@negative count read as a verdict
src/store/ledger.ts@@s/job.run\(d.dayId, "close", d.windowEndMs\);//@@scheduler.test.ts@@close job is not persisted
src/pickup/runner.ts@@s/if \(day.windowVerdict !== null\) return this.settleAlert\(day\);//@@scheduler.test.ts@@close re-entry repeats the observation
src/pickup/scheduler.ts@@s/await runner.drain\(\); //@@scheduler.test.ts@@close job skips the webhook drain
src/pickup/scheduler.ts@@s/ledger.completeJob\(job.id, clock\(\)\);//@@scheduler.test.ts@@finished job never marked done
src/ring/probe.ts@@s/width: \(b\[i \+ 7\] << 8\) \| b\[i \+ 8\]/width: 1/@@probe.test.ts@@probe reports the wrong frame width
src/ring/probe.ts@@s/writeFileSync\(file, f.jpeg\);//@@probe.test.ts@@probe does not save the frame
src/pickup/verdict.ts@@s/return seenLeaving \? \{ verdict: "unverified", takenCount: 0 \} : \{ verdict: "missed", takenCount: 0 \};/return { verdict: "unverified", takenCount: 0 };/@@replay-regressions.test.ts@@overcounted close frame goes back to unverified
src/pickup/verdict.ts@@s/const seenLeaving = .*/const seenLeaving = false;/@@verdict.test.ts@@a seen decrease no longer blocks the missed call
src/pickup/runner.ts@@s/i < zeroRereads/i < 0/@@replay-regressions.test.ts@@zero baseline is not read again
src/pickup/runner.ts@@s/Math.min\(day.closeCount, day.baselineCount\)/day.closeCount/@@replay-regressions.test.ts@@alert quotes the larger disagreeing count
src/server.ts@@s/const known = o.replay.days\(\).some\(\(d\) => d.dayId === body.dayId\);/const known = true;/@@replay-api.test.ts@@replay accepts an unrecorded day
src/ring/token-store.ts@@s/refreshToken: saved \?\? auth.refreshToken/refreshToken: auth.refreshToken/@@token-store.test.ts@@restart ignores the saved refresh token
src/ring/token-store.ts@@s/onRefreshToken: \(t\) => \{ saveRefreshToken\(path, t\); /onRefreshToken: (t) => { /@@token-store.test.ts@@rotated token never saved
src/store/ledger.ts@@s/where device_id = \? and window_start <= \?/where ? is not null and window_start <= ?/@@runner.test.ts@@another doorbell triggers this porch
src/alerts.ts@@s/if \(!res.ok\) throw new Error/if (false) throw new Error/@@alerts.test.ts@@a 500 from the phone webhook counts as delivered
src/alerts.ts@@s/out.every\(\(c\) => !c.ok\)/false/@@alerts.test.ts@@all channels failing does not retry the alert
src/server.ts@@s/if \(createHash\("sha256"\).update\(bytes\).digest\("hex"\) !== obs.frameSha256\)/if (false)/@@evidence.test.ts@@tampered frame served as evidence
src/server.ts@@s/rmSync\(join\(o.runner.d.evidenceDir, id\), \{ recursive: true, force: true \}\);//@@evidence.test.ts@@delete leaves frames on disk
src/store/ledger.ts@@s/for \(const t of \["observations", "jobs", "tracking_readings", "packets"\]\)/for (const t of ["observations"])/@@evidence.test.ts@@delete leaves jobs behind
metric/score.ts@@s/ \|\| r.truth === "partial"//@@score.test.ts@@false reassurance ignores part-taken days
MUT

fresh
for t in webhook.test.ts verdict.test.ts packet.test.ts plan.test.ts scheduler.test.ts probe.test.ts replay-regressions.test.ts replay-api.test.ts token-store.test.ts runner.test.ts alerts.test.ts evidence.test.ts score.test.ts; do
  if run_suite "$TMP/w" "$t"; then echo "GREEN restored $t"; else echo "RESTORED FAILS $t"; fail=1; fi
done
exit $fail
