import { createHash } from "node:crypto";
import type { ArtifactStore } from "../../../packages/adapters/src/providers.js";
import type { IntegrationRequestV1, MissionStore } from "../../../packages/contracts/src/mission.js";
import type { CandidateAdmissionBindingV1, TrustedCheckReceiptV1 } from "../../../packages/contracts/src/verification.js";
import { receiptDigestV1 } from "../../../packages/contracts/src/verification.js";
import { canonicalJson } from "../../../packages/judgment/src/canonical.js";
import type { BareGitFastForwardIntegrator } from "../../../packages/integration/src/local.js";
import { integrationReviewMatches, type IndependentReviewArtifactReader, type TrustedCheckCoordinator } from "../../../packages/governor/src/governor.js";
import type { AdmittingVerificationRunner } from "../../../packages/verification/src/admitting-runner.js";
import type { LifecycleGuard } from "../../../packages/contracts/src/lifecycle.js";

type MissionRecord = NonNullable<Awaited<ReturnType<MissionStore["getMission"]>>>;

export interface CertifiedIntegrationPreparerDependencies {
  readonly store: MissionStore;
  readonly coordinator: TrustedCheckCoordinator;
  readonly admittingRunner: AdmittingVerificationRunner;
  readonly integrator: BareGitFastForwardIntegrator;
  readonly reviews: IndependentReviewArtifactReader;
  readonly artifacts: ArtifactStore;
}

const sha256=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");

/** Transfers exact controller-admitted Git objects and independently persisted check evidence into the fixed local integration stores. */
export function createCertifiedIntegrationPreparer(deps:CertifiedIntegrationPreparerDependencies) {
  return async function prepareCertifiedIntegration(record:MissionRecord,request:IntegrationRequestV1,guard?:LifecycleGuard):Promise<void> {
    await guard?.();
    const mission=record.mission,slice=record.slices.find(row=>row.id===request.sliceId),plan=record.plan;
    if(!plan?.approvedAt||!slice||slice.status!=="awaiting_verification"||!slice.candidateSha||request.candidateSha!==slice.candidateSha||request.missionId!==mission.id||request.sliceId!==slice.id||request.leaseEpoch!==slice.leaseEpoch||mission.repository!==deps.integrator.repositoryIdentity||request.expectedIntegrationSha!==mission.baseSha)throw new Error("Certified integration handoff does not match the persisted approved slice");
    if(canonicalJson([...request.requiredCheckIds].sort())!==canonicalJson([...slice.checks].sort())||new Set(request.requiredCheckIds).size!==request.requiredCheckIds.length||!request.requiredCheckIds.includes("node-repo-suite-v1"))throw new Error("Certified integration check set differs from the approved full-suite slice");
    const planDigest=sha256(Buffer.from(canonicalJson(plan.slices))),integrationPolicy=deps.coordinator.integrationBinding();
    if(request.requiredCheckIds.some(checkId=>!integrationPolicy.allowedChecks.includes(checkId)))throw new Error("Certified integration check set exceeds trusted verifier policy");
    if(!deps.store.getTrustedAttempt)throw new Error("Persisted trusted verifier receipts are unavailable");
    const certifiedEvidence:Array<{receipt:TrustedCheckReceiptV1;stdout:Buffer;stderr:Buffer;manifest:Buffer}>=[];
    for(const checkId of request.requiredCheckIds) {
      await guard?.();
      const certificate=await deps.coordinator.getCertificate(mission.id,slice.id,checkId);
      await guard?.();
      if(!certificate||certificate.scope!=="local-exact-commit"||certificate.missionId!==mission.id||certificate.sliceId!==slice.id||certificate.checkId!==checkId||certificate.candidateSha!==request.candidateSha||certificate.localHeadSha!==request.candidateSha||certificate.leaseEpoch!==slice.leaseEpoch||certificate.repository!==mission.repository||certificate.planDigest!==planDigest||certificate.policyDigest!==integrationPolicy.policyDigest||certificate.policyVersion!==integrationPolicy.policyVersion)throw new Error("Exact final trusted certificate is missing or stale");
      const attempt=await deps.store.getTrustedAttempt(certificate.attemptId),receipt=attempt?.receipt;
      await guard?.();
      if(!attempt||attempt.purpose!=="final"||attempt.outcome!=="pass"||attempt.leasePolicyDigest!==integrationPolicy.leasePolicyDigest||!receipt||receipt.outcome!=="pass"||receipt.receiptDigest!==certificate.receiptDigest||receipt.receiptDigest!==receiptDigestV1(receipt)||canonicalJson(receipt.request)!==canonicalJson(attempt.request)||receipt.verifierId!==integrationPolicy.verifierId||attempt.request.attemptId!==certificate.attemptId||attempt.request.missionId!==mission.id||attempt.request.sliceId!==slice.id||attempt.request.leaseEpoch!==slice.leaseEpoch||attempt.request.checkId!==checkId||attempt.request.repository!==mission.repository||attempt.request.candidateSha!==request.candidateSha||attempt.request.expectedLocalHeadSha!==request.candidateSha||attempt.request.planDigest!==planDigest||attempt.request.policyVersion!==integrationPolicy.policyVersion||attempt.request.policyDigest!==integrationPolicy.policyDigest||attempt.request.verifierImageDigest!==integrationPolicy.imageDigest)throw new Error("Persisted final PASS receipt does not match its certificate");
      const verified=await deps.admittingRunner.verifyArtifacts(receipt);
      await guard?.();
      certifiedEvidence.push({receipt,stdout:verified.stdout,stderr:verified.stderr,manifest:verified.manifest});
    }
    await guard?.();const review=await deps.reviews.read(request.reviewArtifactId);await guard?.();
    if(!review||sha256(review)!==request.reviewArtifactDigest)throw new Error("Exact independent review artifact is unavailable or changed");
    const binding:CandidateAdmissionBindingV1={version:"orloom.candidate-admission.v1",missionId:mission.id,sliceId:slice.id,leaseEpoch:slice.leaseEpoch,repository:mission.repository,baseSha:mission.baseSha,candidateSha:slice.candidateSha,planDigest,trustedCheckPolicyDigest:integrationPolicy.leasePolicyDigest,scopes:[...slice.scopes],evidenceRefs:[...slice.evidenceRefs]};
    await guard?.();const admitted=await deps.admittingRunner.admitForController(binding);await guard?.();
    if(admitted.receipt.candidateSha!==request.candidateSha||admitted.receipt.binding.repository!==mission.repository||admitted.receipt.binding.missionId!==mission.id||admitted.receipt.binding.sliceId!==slice.id||admitted.receipt.binding.leaseEpoch!==slice.leaseEpoch||admitted.receipt.binding.baseSha!==mission.baseSha||admitted.receipt.binding.planDigest!==planDigest||admitted.receipt.binding.trustedCheckPolicyDigest!==integrationPolicy.leasePolicyDigest||canonicalJson([...admitted.receipt.binding.scopes].sort())!==canonicalJson([...slice.scopes].sort()))throw new Error("Trusted candidate admission returned a different source binding");
    if(!integrationReviewMatches(review,request,slice,admitted.receipt.treeSha))throw new Error("Independent review does not bind the admitted candidate tree, reviewer, builder and exact scope");
    await guard?.();const imported=await deps.integrator.importAdmittedCandidate(admitted.repository,request.candidateSha,request.expectedIntegrationSha,[...slice.scopes]);await guard?.();
    if(imported.candidateSha!==request.candidateSha||imported.treeSha!==admitted.receipt.treeSha)throw new Error("Imported candidate tree differs from the trusted admission receipt");

    for(const item of certifiedEvidence) {
      await publishExactArtifact(deps.artifacts,item.stdout,item.receipt.stdout.sha256,item.receipt.stdout.bytes,"text/plain",guard);
      await publishExactArtifact(deps.artifacts,item.stderr,item.receipt.stderr.sha256,item.receipt.stderr.bytes,"text/plain",guard);
      await publishExactArtifact(deps.artifacts,item.manifest,item.receipt.inputManifest.sha256,item.receipt.inputManifest.bytes,"application/json",guard);
    }
  };
}

async function publishExactArtifact(store:ArtifactStore,bytes:Buffer,expectedSha:string,expectedBytes:number,contentType:string,guard?:LifecycleGuard):Promise<void> {
  if(bytes.length!==expectedBytes||sha256(bytes)!==expectedSha)throw new Error("Trusted verifier artifact differs from its persisted digest or byte count");
  await guard?.();
  const saved=await store.put(bytes,contentType);
  await guard?.();
  if(saved.sha256!==expectedSha||saved.key!==`sha256/${expectedSha}`)throw new Error("Evidence artifact store returned a different content address");
  const readback=Buffer.from(await store.get(saved.key));
  await guard?.();
  if(readback.length!==expectedBytes||sha256(readback)!==expectedSha||!readback.equals(bytes))throw new Error("Evidence artifact store readback differs from the verified verifier artifact");
}
