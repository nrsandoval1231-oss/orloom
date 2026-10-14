import { createHash } from "node:crypto";
import type { CandidateAdmissionBindingV1, TrustedCheckReceiptV1, TrustedCheckRequestV1 } from "../../contracts/src/verification.js";
import type { TrustedCheckRunner } from "../../governor/src/governor.js";
import { canonicalJson } from "../../judgment/src/canonical.js";
import { CandidateAdmission } from "./candidate-admission.js";
import type { InputBundle } from "./repository.js";
import { TrustedVerificationRunner, type TrustedVerificationRunnerOptions } from "./runner.js";

/** One shared verifier retains its original concurrency/policy/artifact boundary.
 * Per-candidate facades carry immutable source identity; they cannot retarget it. */
export class AdmittingVerificationRunner implements TrustedCheckRunner {
  private readonly verifier:TrustedVerificationRunner;
  constructor(options:TrustedVerificationRunnerOptions,private readonly admission:CandidateAdmission){this.verifier=new TrustedVerificationRunner(options);}
  async prepareBundle(_repository:string,_baseSha:string,_candidateSha:string):Promise<InputBundle>{throw new Error("Controller candidate admission is required before verification preparation");}
  async observeHead(_repository:string):Promise<{sha:string;observedAt:string;digest:string}>{throw new Error("Controller candidate admission is required before head observation");}
  async run(_request:TrustedCheckRequestV1,_bundle:InputBundle):Promise<TrustedCheckReceiptV1>{throw new Error("Controller candidate admission is required before verification execution");}
  verifyArtifacts(receipt:TrustedCheckReceiptV1){return this.verifier.verifyArtifacts(receipt);}
  async forCandidate(value:CandidateAdmissionBindingV1):Promise<TrustedCheckRunner>{
    const binding=structuredClone(value),admitted=await this.admission.admit(binding);
    const reread=async()=>{const current=await this.admission.admit(binding);if(current.receipt.admissionDigest!==admitted.receipt.admissionDigest||current.input.digest!==admitted.input.digest)throw new Error("Candidate admission source binding changed");return current;};
    return {
      prepareBundle:async(repository,baseSha,candidateSha)=>{
        if(repository!==binding.repository||baseSha!==binding.baseSha||candidateSha!==binding.candidateSha)throw new Error("Candidate source binding mismatch");
        return (await reread()).input;
      },
      observeHead:async(repository)=>{
        if(repository!==binding.repository)throw new Error("Candidate source binding mismatch");
        const current=await reread(),observedAt=new Date().toISOString(),sha=current.receipt.candidateSha;
        return {sha,observedAt,digest:createHash("sha256").update(canonicalJson({version:"orloom.admitted-head-observation.v1",repository,sha,observedAt,admissionDigest:current.receipt.admissionDigest,bundleDigest:current.receipt.bundleDigest,inputManifestDigest:current.input.digest})).digest("hex")};
      },
      run:async(request,bundle)=>{
        if(request.repository!==binding.repository||request.missionId!==binding.missionId||request.sliceId!==binding.sliceId||request.leaseEpoch!==binding.leaseEpoch||request.planDigest!==binding.planDigest||request.candidateSha!==binding.candidateSha||request.expectedLocalHeadSha!==binding.candidateSha||request.inputBundleDigest!==admitted.input.digest)throw new Error("Verifier request does not match candidate admission binding");
        const current=(await reread()).input;
        if(bundle.digest!==current.digest||!bundle.manifest.equals(current.manifest)||bundle.files.size!==current.files.size||[...current.files].some(([name,bytes])=>!bundle.files.get(name)?.equals(bytes)))throw new Error("Verifier input differs from admitted source binding");
        return this.verifier.run(request,current);
      },
      verifyArtifacts:receipt=>this.verifier.verifyArtifacts(receipt),
    };
  }
}
