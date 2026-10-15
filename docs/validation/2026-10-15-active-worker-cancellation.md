# Active-worker cancellation: source implementation, operational acceptance OPEN

Base: merged main `d212443` (PRs #21–23). This focused successor does not activate the normal worker entrypoint, providers, production execution, delivery, or publication. It does not change runtime-journal v2 or the authenticated owner cancellation contract.

## Implemented behavior

- The worker polls `POST /api/worker/missions/{missionId}/slices/{sliceId}/cancellation` using its exact epoch, lease token, and capability token. It cannot request owner cancellation or submit a termination receipt. Invalid/foreign/expired lease credentials never disclose a cancellation. Missing monitoring support returns unavailable, and HTTP monitoring errors abort local execution conservatively.
- Cancellation monitoring runs before workspace creation and serially every second while execution is active. It fences subsequent provider/tool/candidate actions. Late provider replies cannot trigger another tool or candidate. Local abort alone yields UNKNOWN, not successful cancellation.
- Durable intent precedes creation; exact container binding is now persisted **before start**. Cancellation during binding prevents start. The workspace installs an abort listener that independently begins cleanup of the container, rather than relying on a provider request to return.
- Cleanup and restart reconciliation use the retained 64-character container ID. Before removal the trusted host independently checks the exact name, configured pinned image reference, and complete ownership-label digest. It removes by immutable ID, then independently inspects for absence. A remove command's exit status never establishes absence.
- Daemon errors, foreign identity, continued presence, and unbound creation intent remain UNKNOWN. Partial creation cannot be inferred absent from name lookup. UNKNOWN is durably retained and can later become absent after exact reconciliation; no container is recreated from a journal record.
- The retained broker composition acquires a Linux process-lifetime flock before bootstrap, opens the protected journal, and reconciles interrupted containers before claims. Unresolved UNKNOWN refuses startup. The kernel releases the flock after process death. The operator must provision `/var/lib/orloom/worker-service.lock` as a private service-owned regular file and `/var/lib/orloom/worker-runtime` as a private service-owned real directory. The lock is outside the journal root. The normal worker entrypoint remains disabled.
- Workspace close is idempotent. Docker attach clients are boundedly killed/reaped even when daemon reconciliation fails. Runtime absence evidence stays separate from controller mission settlement.

## Acceptance and limitations

Source/fixture acceptance covers repeated owner requests, real loopback HTTP authentication and epoch checks, running-provider cancellation with a deliberately late tool reply, cancellation during durable binding through a subprocess Docker-protocol fixture, exact-ID removal checks, restart journal reopening, failed/ambiguous removal, and actual Linux lock-owner SIGKILL/reacquisition.

**The Docker protocol fixture is simulated.** It is not an isolated engineering worker. PGlite/memory tests are not live PostgreSQL proof. No Docker CLI, Docker socket, or runsc binary is available in this workspace. No cloud host was provisioned and no provider was activated. Genuine disposable-mission acceptance remains OPEN.

**Trusted controller settlement remains OPEN.** The local journal can retain verified absence, but no worker receipt can finish a mission or release its capacity. Running cancelled slices remain `cancel_requested`, missions remain `cancelling`, capacity stays reserved, and execution budgets are not refunded. This draft must not be presented as completed end-to-end cancellation. The next trusted controller composition must consume independently retained host reconciliation evidence, bind mission/slice/epoch/run identity, account for uncertain provider spend and other active effects, and transact durable settlement. This requires a separately reviewed trust/transport boundary; adding a worker-submitted “stopped” receipt here would defeat the existing contract.

## Required genuine acceptance before activation

On an authorized protected Linux host with the reviewed worker image already pinned/preloaded and runsc configured:

1. Acquire the exclusive broker lock and use disposable mission/repository and dedicated durable journal paths. Keep provider, delivery and publication authority disabled.
2. Prove a real isolated worker/check is running; retain exact image, name, labels, container ID, and resource-policy inspection before owner cancellation.
3. Send authenticated owner cancellation twice with the same request ID. Demonstrate local fencing and independently inspect disappearance of the exact container. Retain the journal's absence observation and show no candidate/delivery effect.
4. Interrupt the broker during active work and again between remove and journal settlement. Restart under the same service lock and journal; reconcile the exact retained identity without redispatch or resurrection.
5. Inject daemon inspection failure, failed stop, unknown creation and identity substitution. Each must remain UNKNOWN/quarantined without capacity release or budget refund.
6. Exercise the independently reviewed controller settlement bridge against live PostgreSQL. Prove no process or outstanding effect remains and uncertain spend is conservatively charged/retained before any release.

## Validation evidence

The retained final full-suite output is adjacent to this record as `active-worker-cancellation-suite.txt`. Build is included in `npm test`; typecheck, structure validation, and diff whitespace checks are also run. The final result and independent review are recorded below before PR publication.

Final local Linux results: `npm run typecheck` PASS; `npm run validate` PASS; `npm test` exit 0, **265 tests / 264 pass / 0 fail / 1 existing skip**. The skipped test is `operational journal opening is Linux-only and cannot silently use portable validation`, annotated by the existing suite as requiring the deployment-host acceptance lane. No Windows run was performed. The formerly reported 13 Windows/POSIX failures do not occur on this Linux run. npm emits its existing environment `http-proxy` configuration warning.

Independent reviewer: separate read-only agent reviewed the source, identified pre-start race, restart ownership, and attach cleanup issues, and re-reviewed their fixes. Final finding: **no remaining confirmed source safety blocker**. Its independent focused run passed **44/44 tests, zero failures/skips**. It explicitly retained the genuine runtime and trusted controller settlement gaps. No approval/merge/activation claim follows from that review.

SHA-256 of reviewed implementation and regression files:

```text
d8bf16c1b842b0451b746de745bee2d271c0314010a79a507d4d11363520b484  apps/control-plane/src/server.ts
62cb716e9c979ab014fb4f0e4a8271d2db6eeab1c1c8243920df3bb5c4eb77e2  apps/worker/src/broker-main.ts
3c3e483d263c8e00b51c2d3b9ed3f56ef3eba518372f81fb59386fa35a7f2983  apps/worker/src/docker-runtime.ts
0daf193e1362d6fef9188b70033e99db07133ccd06277dfc31237714c17b275a  apps/worker/src/service-lock.ts
e83842a92cd202c463a03b69ad3322a7f0246a38161be6f636c7e03b7f9d6db9  packages/agents/src/worker.ts
5b9f966f8f458b6779be94aa759d5ac8c1ff6a1a9f7abc3e595d4b00afa2d5c5  tests/active-worker-cancellation.test.ts
c5890548a664431ef1d83ecf274891987d2a121ab460511cbdeab435c3f0bf21  tests/runtime-cancellation.test.ts
2193c140122b1839d532b8c4d3e4e4887cf17313b18061428eb3f6b6a8fe1d8e  tests/worker-broker.test.ts
4e05689c820833d809a5b1ba6a7d8a70f05931bd03f70d9acae7eaeddb2db601  tests/worker-service-lock.test.ts
```
