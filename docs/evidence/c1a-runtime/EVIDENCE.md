# C1a bounded runtime evidence

Source candidate: `545279c7b53fef8453c8e50ae0bc7f0d790959af`, branch `feat/judgment-recovery`, from merged main `6110c692f47202978b2d22d22f6522aa4aa59277`. The actual source checkout was `work/orloom-main-review`. PR #2 remained frozen at `8bbcfffbf631e5ad2972e34b41284198afc566e2`.

The controller reproduced installation, typecheck, build, all 51 tests, structure validation and diff checks. Raw output is `CONTROLLER-GATES-545279c.txt`. Independent source review returned bounded PASS in `REVIEW-SOURCE-545279c.json`, conditional on this real PostgreSQL proof and final reconciliation. The source manifest is `.agent/ORL-005C1-MANIFEST.sha256`, SHA256 `85612beddd1d5b81bd2987fc6980c149f87092d42b316e54ea6af93c8e5fbace`; the controller checked all 36 entries against working and staged bytes and again in a fresh checkout.

## Observed behavior

`runtime-result-attempt3.txt` records the successful HTTP/control-plane/real PostgreSQL run on the existing dedicated DigitalOcean host. This executed actual `SqlMissionStore` and `PostgresJobStore` source, not an in-memory replacement. A controlled JavaScript fixture returned 41, failed the check requiring 42, followed the Governor-selected materially different strategy, and passed that same check after the fixture was repaired. The retained receipts prove fixture outcomes, not independent production verification.

The proof also exercises authenticated policy binding; two distinct slice episodes and durable lesson candidates; promotion denial; UNKNOWN pass exclusion in either order; scope cohort exclusion and unsorted-scope parity; ordinal/capability/conflicting replay fences; canonical replay; lease expiry quarantine; and an in-flight budget change on another PostgreSQL connection causing stale judgment to become UNKNOWN while retaining budget, capacity and scope. The held judgment ran outside the transaction. Three concurrent backend PIDs were observed: 4457, 4458, 4459. Reconnect/control-plane restart and event cursor replay passed. Provider calls: zero.

The controller independently decoded and hashed **18** fixture receipts: **8 passing and 10 failing**. Every recorded hash matched its bytes and every fixture exit agreed with its invariant. The number 42 is the fixture's expected answer, not the number of recorded outcomes.

## Identity and retained failures

- Raw PASS output SHA256: `ff7b5a9a26aebc9fb08437d32bcdaf410bedb0c2954aa6f21f8f666c923fc6d5`.
- Executed runner SHA256: `facf0a089edcd361b27e674f1ad0f8cd9e9ebc4fe43dea1d7aef0c3b9895dbc9`.
- Accepted 150-file payload manifest SHA256: `77322aa943bc1df89931f96f917bfb020eb98385e3b590b543d50e22f3cc4ec3`; identity is in `payload-identity-04.json`.
- Original 14-entry evidence manifest SHA256: `978a092b46641a36515f5eb7b94d5de3682285b6af8a27bdcae5a26fbec155c8`. The controller recomputed all entries before copying them unchanged here. Additional controller/reproduction files are outside that producer manifest.

The raw producer `FINAL-HANDOFF.md` is preserved unchanged. It has three clerical errors: the checkout is `work/orloom-main-review`, the manifest filename has `C1` rather than `C1A`, and there are 18 receipts rather than 42 outcomes. The identities and counts above supersede those claims without rewriting the original record.

Attempt 1 failed at bootstrap because runsc could not resolve Docker's `pg` alias. The next connection used only the exact test network's metadata-derived private address; network isolation was retained. Attempt 2 failed in the proof's expected challenge digest because fields were omitted. Attempt 3 corrected the harness and used fresh databases. No application source changed between these attempts. Setup/staging CRLF errors and ambiguous initial command status were investigated using exact object metadata before proceeding; setup was not blindly repeated. Failed outputs and explanations are retained alongside the PASS output.

## Cleanup and reproduction boundaries

The disposable PostgreSQL/test containers, internal network, secret and staging volumes, and `/var/lib/orloom/c1a-pg-proof-20261013` were removed after the proof. `REMOTE-CLEANUP-POSTCHECK.txt` records cleanup; the controller independently repeated the read-only absence and protected-container checks. The existing `codex-universal` container retained ID `5825fae55e2817dab3f3b8f552ea713f3e6124d0d647a33398e3c5b04b7cdd67`, start time `2026-10-12T23:51:46.164222792Z`, restart count 0, runtime runc, running state. No production database, Hostinger service, credentials, or frozen broker was changed.

Scripts retain the original workstation layout and exact disposable object identities. They are evidence, not a safe copy-and-run deployment recipe. Reproduction requires a fresh isolated checkout of the source SHA, the committed lockfile/build, a new reviewed disposable resource identity, and adaptation of the guarded paths. `prepare-payload.mjs` expects the original `work/c1-runtime-proof` layout and rejects another source head or dirty tree. Do not reuse removed resource IDs or execute cleanup against unrelated objects. Payload dependencies and credentials are intentionally absent from Git.

## Acceptance limit

Final independent evidence review returned **PASS**, retained in `REVIEW-FINAL.json` (SHA256 `bc7f63943707cf50c40c60e1d8365b34f7a851228cc8d818c3354e3ab24e03d8`). It checked all 36 source entries, 14 producer evidence entries, 18 receipt hashes/outcomes, raw gates, actual HTTP/SQL/pool/fencing/reconnect assertions, failed attempts, cleanup and secret-output boundaries. Source review coverage remains the exact source commit above; later evidence-only commits do not extend that source review to new implementation.

This establishes the bounded C1a recovery/candidate checkpoint on its feature branch. C1b independent lesson challenge/promotion, downstream comparable-task use, withdrawal, broader stuck signals, and measured improvement remain OPEN. C3 independent verification, cloud deployment, actual Jev/DeepSeek execution, six-builder capacity, R2 retention, GitHub App delivery and commercial platform completion remain unproven. Time and token usage not measured by retained evidence are UNKNOWN. No speed or quality gain is claimed.
