import { test } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { certificateLinkAvailable, loomDocument } from "../apps/control-plane/src/loom-page.js";

test("certificate links exist only while the matching current slice is awaiting verification", () => {
  const event = { sliceId: "s-1", checkId: "check:unit", references: [{ kind: "candidate", id: "a".repeat(40) }] };
  const awaiting = { id: "s-1", status: "awaiting_verification", candidateSha: "a".repeat(40), checks: ["check:unit"] };
  assert.equal(certificateLinkAvailable(awaiting, event), true);
  assert.equal(certificateLinkAvailable({ ...awaiting, status: "verified" }, event), false);
  assert.equal(certificateLinkAvailable({ ...awaiting, candidateSha: "b".repeat(40) }, event), false);
  assert.equal(certificateLinkAvailable({ ...awaiting, checks: ["other"] }, event), false);
  assert.equal(certificateLinkAvailable(undefined, event), false);
});

test("Loom renders its tested certificate rule and keeps explicit fallback and bounded polling controls", () => {
  const html = loomDocument("nonce-value");
  const source = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert(source);
  assert.doesNotThrow(() => new Script(source));
  assert.match(source, /fallback\.removeAttribute\('hidden'\)/);
  assert.match(source, /fallback\.setAttribute\('hidden',''\)/);
  assert.match(source, /details\.open=true/);
  assert.match(source, /e\.key==='Enter'\|\|e\.key===' '/);
  assert.match(source, /pollTimer=setTimeout/);
  assert.match(source, /clearTimeout\(pollTimer\)/);
  assert.match(source, /certificateAvailable\(slice,e\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|innerHTML/);
});
