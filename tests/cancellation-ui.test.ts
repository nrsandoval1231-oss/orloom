import assert from "node:assert/strict";
import test from "node:test";
import { commandCenterDocument } from "../apps/control-plane/src/command-center.js";

test("cancellation uses the inline accessible confirmation form and durable status routes",()=>{
  const html=commandCenterDocument(true,"cloud","nonce",[]);
  const script=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert(script,"Command Center script is present");
  new Function(script);
  assert.match(script,/cancel-request-form/);
  assert.match(script,/Confirm cancellation request/);
  assert.match(script,/cancelStatus\.setAttribute\('role','status'\)/);
  assert.match(script,/\/cancel','POST'/);
  assert.match(script,/\/cancellation'/);
  assert.match(script,/Runtime absence is not confirmed/);
  assert.match(script,/const cancellationRequestId=crypto.randomUUID()/);
  assert.match(script,/ownerRequestId:cancellationRequestId/);
  assert.match(script,/No retry was sent/);
  assert.doesNotMatch(script,/\b(?:prompt|alert)\s*\(/);
  assert.equal((script.match(/async function showMission\(/g)||[]).length,1);
  assert.doesNotMatch(script,/cancelMission/);
});
