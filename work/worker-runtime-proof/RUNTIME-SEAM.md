# Actual DockerWorkerRuntime proof: current boundary and minimal seam

## Finding

The existing `DockerWorkerRuntime` does not expose a local-checkout injection. `DockerWorkerRuntimeOptions` supplies only the `ReadOnlyCheckoutToken` (`createCheckoutToken`), checks, scratch root, Docker path, and image reference. `DockerWorkspace.checkout()` calls `checkoutExact(...)` directly. `checkoutExact()` always fetches `https://github.com/${lease.mission.repository}.git` after requesting a checkout token. Its interface has no Git remote/fetch transport parameter and does not accept a fixture directory. A fake token provider therefore cannot keep the test local: the subsequent Git fetch still targets GitHub.

There is a second execution constraint: `DockerWorkspace.checkout()` rejects when `process.platform !== "linux"`. This development host is Windows. The only target Linux host is the dedicated DO host, where no remote work is authorized until the sandbox source is frozen and the controller dispatches it.

Therefore the current `run_proof.py` remains a compiled `sandbox-entry.js` stdio fixture. It does not instantiate `DockerWorkerRuntime`, claim the checkout/bridge path, or validate the provider/broker. No workaround was attempted using PATH shims, Git config tricks, DNS/TLS redirection, live GitHub access, or a fake runtime.

## Minimal source seam requested

To run the real runtime against a disposable local Git fixture, add a narrow optional checkout-fetch dependency to the production `checkoutExact` call path (with the normal GitHub HTTPS fetch as the unchanged default). The fixture implementation must fetch from a local bare Git repository without external network. Keep `checkoutExact`'s existing immutable repository/base checks and final `rev-parse HEAD === lease.mission.baseSha` check outside the injected transport so the fixture cannot bypass identity validation. Do not add an unrestricted `checkoutDirectory` override or injectable whole-runtime implementation.

A future test can then create a disposable bare fixture repository, use a fixed synthetic token provider, construct the actual compiled `DockerWorkerRuntime` with a digest-pinned image and fixed trusted check map, and open two workspaces concurrently. It should verify each workspace sees only its fixture checkout, perform read/replace/check/snapshot and candidate-bundle validation, force an abort during a bounded large RPC, call `close`, and verify both exact `orloom-worker-*` container IDs/names have disappeared. These are local transport and runtime lifecycle checks only, not provider or lane-capacity proof.

## Existing runtime RPC/cleanup notes

The current `DockerRpc.request()` caps JSON request size at 16,000,000 bytes and waits for `stdin.write()` drain before awaiting the response. A large request with an abort during that drain wait deserves a targeted regression after freeze; the abort handler kills the Docker client process, but the drain wait itself has no abort listener. The cleanup method launches `docker rm --force --time 1 <name>` and resolves on process close without checking the exit code, so an actual-runtime test must inspect the exact owned name/ID after `workspace.close()` instead of treating `close()` alone as cleanup proof.

## State

Source review only. No source files edited; no GitHub access, Docker build, SSH, provider call, or host mutation. Source hashes and target runtime state remain UNKNOWN pending freeze and dispatch.
