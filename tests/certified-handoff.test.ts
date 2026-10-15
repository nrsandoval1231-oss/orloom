import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createCertifiedIntegrationPreparer } from "../apps/worker/src/certified-handoff.js";
import { parseTrustedCheckRequestV1, receiptDigestV1 } from "../packages/contracts/src/verification.js";
import { canonicalJson } from "../packages/judgment/src/canonical.js";

const hash=(value:Uint8Array|string)=>createHash("sha256").update(value).digest("hex");
function harness(options:{readbackMutation?:(bytes:Buffer)=>Buffer;missingCertificate?:boolean;invalidReview?:boolean}={}) {
  const missionId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",sliceId="slice",baseSha="1".repeat(40),candidateSha="2".repeat(40),policyDigest=hash("policy"),leasePolicyDigest=hash("lease-policy"),imageDigest=hash("image"),treeSha="3".repeat(40),planSlices=[{id:sliceId,objective:"edit",dependencies:[],owner:"builder",scopes:["src"],checks:["node-repo-suite-v1"],budgetCents:50}],planDigest=hash(canonicalJson(planSlices));
  const record={mission:{id:missionId,repository:"owner/repo",baseSha,objective:"",acceptance:[],budgetCents:100,reservedCents:50,status:"awaiting_verification",createdAt:""},plan:{missionId,slices:planSlices,recommendedBy:"owner",recommendedAt:"",approvedAt:"2026-10-15T00:00:00.000Z"},slices:[{...planSlices[0],missionId,status:"awaiting_verification",leaseEpoch:1,leaseToken:null,leaseExpiresAt:null,candidateSha,evidenceRefs:["candidate-bundle:sha256/"+hash("bundle"),"evidence-index:sha256/"+hash("index")]}]} as any;
  const startedAt="2026-10-15T00:00:00.000Z",finishedAt="2026-10-15T00:00:01.000Z";
  const request=parseTrustedCheckRequestV1({version:"orloom.trusted-check-request.v1",attemptId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",missionId,sliceId,leaseEpoch:1,repository:"owner/repo",candidateSha,expectedLocalHeadSha:candidateSha,planDigest,checkId:"node-repo-suite-v1",policyVersion:"v1",policyDigest,verifierImageDigest:imageDigest,inputBundleDigest:hash("input"),requestedAt:startedAt,expiresAt:"2026-10-15T00:01:00.000Z"});
  const stdout=Buffer.from("trusted stdout"),stderr=Buffer.from(""),manifest=Buffer.from("{}\n");
  const reviewBytes=Buffer.from(canonicalJson({version:"orloom.independent-review.v1",verdict:options.invalidReview?"FAIL":"PASS",candidateSha,treeSha,reviewer:"independent-reviewer",builder:"builder",scopes:["src"]}));
  const receiptBody={version:"orloom.trusted-check-receipt.v1" as const,request,verifierId:"verifier",runtime:"runsc" as const,sandboxId:"sandbox",outcome:"pass" as const,exitCode:0,startedAt,finishedAt,stdout:{key:`sha256/${hash(stdout)}` as `sha256/${string}`,sha256:hash(stdout),bytes:stdout.length},stderr:{key:`sha256/${hash(stderr)}` as `sha256/${string}`,sha256:hash(stderr),bytes:stderr.length},inputManifest:{key:`sha256/${hash(manifest)}` as `sha256/${string}`,sha256:hash(manifest),bytes:manifest.length}};
  const receipt={...receiptBody,receiptDigest:receiptDigestV1(receiptBody)};
  const certificate={version:"orloom.check-certificate.v1" as const,certificateId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",attemptId:request.attemptId,missionId,sliceId,leaseEpoch:1,repository:"owner/repo",candidateSha,localHeadSha:candidateSha,checkId:request.checkId,planDigest,policyVersion:"v1",policyDigest,receiptDigest:receipt.receiptDigest,certifiedAt:startedAt,scope:"local-exact-commit" as const};
  const stored=new Map<string,Buffer>();
  const artifacts={async put(bytes:Uint8Array){const value=Buffer.from(bytes),sha256=hash(value),key=`sha256/${sha256}`;stored.set(key,value);return{key,sha256};},async get(key:string){const value=stored.get(key);if(!value)throw new Error("missing");return options.readbackMutation&&key===`sha256/${hash(stdout)}`?options.readbackMutation(value):value;}};
  const coordinator={integrationBinding:()=>({allowedChecks:[request.checkId],policyDigest,policyVersion:"v1",imageDigest,verifierId:"verifier",leasePolicyDigest}),getCertificate:async()=>options.missingCertificate?null:certificate} as any;
  const store={getTrustedAttempt:async()=>({purpose:"final",outcome:"pass",leasePolicyDigest,request,receipt})} as any;
  let imported=0;
  const integrator={repositoryIdentity:"owner/repo",importAdmittedCandidate:async(_source:any,sha:string,base:string)=>{imported++;return{candidateSha:sha,previousSha:base,treeSha,changedPaths:["src/a.js"]};}} as any;
  const admittingRunner={admitForController:async(binding:any)=>({repository:{objectStore:"/private/admission/objects.git",approvedRef:"refs/heads/admitted-candidate"},receipt:{candidateSha,binding,treeSha}}),verifyArtifacts:async()=>({stdout,stderr,manifest})} as any;
  const reviews={read:async()=>reviewBytes};
  const prepare=createCertifiedIntegrationPreparer({store,coordinator,admittingRunner,integrator,reviews,artifacts});
  const integrationRequest={version:"orloom.integration-request.v1" as const,missionId,sliceId,expectedIntegrationSha:baseSha,candidateSha,leaseEpoch:1,requiredCheckIds:[request.checkId],reviewArtifactId:"review-1",reviewArtifactDigest:hash(reviewBytes)};
  return{prepare,record,request:integrationRequest,stored,certificate,receipt,imported:()=>imported};
}

test("certified handoff uploads only digest-matching final verifier evidence after candidate identity checks",async()=>{
  const h=harness();await h.prepare(h.record,h.request);
  assert.equal(h.imported(),1);
  assert.equal(h.stored.get(h.receipt.stdout.key)?.toString(),"trusted stdout");
  assert.equal(h.stored.get(h.receipt.stderr.key)?.length,0);
  assert.equal(h.stored.get(h.receipt.inputManifest.key)?.toString(),"{}\n");
});

test("certified handoff refuses artifact-store readback substitution and never promotes a Git ref",async()=>{
  const h=harness({readbackMutation:bytes=>Buffer.from(`${bytes.toString()} altered`)});
  await assert.rejects(h.prepare(h.record,h.request),/readback/);
  assert.equal(h.imported(),1,"handoff may import objects, but its importer has no ref-promotion API");
});

test("certified handoff refuses a missing final certificate before admission import or artifact publication",async()=>{
  const h=harness({missingCertificate:true});
  await assert.rejects(h.prepare(h.record,h.request),/certificate/);
  assert.equal(h.imported(),0);assert.equal(h.stored.size,0);
});

test("certified handoff applies the Governor review validator before import or artifact publication",async()=>{
  const h=harness({invalidReview:true});
  await assert.rejects(h.prepare(h.record,h.request),/Independent review/);
  assert.equal(h.imported(),0);assert.equal(h.stored.size,0);
});

test("certified handoff refuses stale persisted candidate bindings before import",async()=>{
  const h=harness(),forged={...h.request,candidateSha:"4".repeat(40)};
  await assert.rejects(h.prepare(h.record,forged),/persisted approved slice/);
  assert.equal(h.imported(),0);
});
