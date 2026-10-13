import type { TrustedCheckService } from "../../contracts/src/verification.js";

/** Controller-owned dependency. Neither an owner request nor a worker supplies this. */
export interface LearningActivation { assertAccepted(): Promise<void>; }

/** Rechecks the pinned integrated runtime's full-suite certificate on every promotion. */
export class CertifiedLearningActivation implements LearningActivation {
  constructor(private readonly checks: Pick<TrustedCheckService, "getCertificate">,
    private readonly binding: { missionId: string; sliceId: string; runtimeSha: string; certificateId: string; policyDigest: string }) {}
  async assertAccepted(): Promise<void> {
    const b = this.binding;
    const c = await this.checks.getCertificate(b.missionId, b.sliceId, "node-repo-suite-v1");
    if (!c || c.checkId !== "node-repo-suite-v1" || c.missionId !== b.missionId || c.sliceId !== b.sliceId
      || c.candidateSha !== b.runtimeSha || c.localHeadSha !== b.runtimeSha
      || c.certificateId !== b.certificateId || c.policyDigest !== b.policyDigest
      || c.scope !== "local-exact-commit") throw new Error("Learning runtime acceptance is unavailable");
  }
}
