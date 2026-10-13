import { test } from "node:test";
import assert from "node:assert/strict";
import { createGitHubAppAdapter, type GitHubRequestBoundary } from "../packages/adapters/src/providers.js";

type Call = { route: string; parameters: Record<string, unknown> };

function fakeBoundary(token: string | undefined, calls: Call[]): GitHubRequestBoundary {
  return {
    app: {
      async request(route, parameters) {
        calls.push({ route, parameters });
        return { data: token === undefined ? {} : { token } };
      }
    },
    async installation() {
      throw new Error("checkout token must use the app request boundary");
    }
  };
}

test("checkout token requests exactly one repository with contents read only", async () => {
  const calls: Call[] = [];
  const adapter = createGitHubAppAdapter({ appId: 123, privateKey: "fake-key-for-injected-boundary" }, fakeBoundary("fake-checkout-token", calls));

  assert.equal(await adapter.createCheckoutToken(44, "allowed-repo"), "fake-checkout-token");
  assert.deepEqual(calls, [{
    route: "POST /app/installations/{installation_id}/access_tokens",
    parameters: {
      installation_id: 44,
      repositories: ["allowed-repo"],
      permissions: { contents: "read" }
    }
  }]);
});

test("checkout token rejects invalid installation IDs and repository names before any request", async () => {
  const calls: Call[] = [];
  const adapter = createGitHubAppAdapter({ appId: 123, privateKey: "fake-key-for-injected-boundary" }, fakeBoundary("fake-checkout-token", calls));

  for (const installationId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    await assert.rejects(adapter.createCheckoutToken(installationId, "allowed-repo"), /scope/);
  }
  const invalidRepositories: unknown[] = ["", ".", "..", "repo/name", "repo\nname", "repo\rname", "../outside", "a".repeat(101), null, undefined, 42];
  for (const repository of invalidRepositories) {
    await assert.rejects(adapter.createCheckoutToken(44, repository as string), /scope/);
  }

  assert.deepEqual(calls, []);
});

test("checkout token rejects a missing or blank token response", async () => {
  for (const token of [undefined, "", " \t\n"]) {
    const calls: Call[] = [];
    const adapter = createGitHubAppAdapter({ appId: 123, privateKey: "fake-key-for-injected-boundary" }, fakeBoundary(token, calls));
    await assert.rejects(adapter.createCheckoutToken(44, "allowed-repo"), /did not return an installation token/);
    assert.equal(calls.length, 1);
  }
});
