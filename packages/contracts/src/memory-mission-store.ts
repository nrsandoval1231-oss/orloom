import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eligibleLessonPair, lessonChallengeDigest, lessonEpisodeKey, lessonRule, scopeCohort } from "../../learning/src/lesson-policy.js";
import { canonicalJson } from "../../judgment/src/canonical.js";
import { deterministicRecovery } from "../../stuck-resolver/src/recovery.js";
import type { DecisionSnapshotV1, JudgmentV1 } from "../../judgment/src/types.js";
import { canonicalRepository, ClaimAdvice, GovernorActionV1, Lane, LeaseGrant, LessonCandidate, Mission, MissionConflictError, MissionEvent, MissionInput, MissionPlan, MissionSlice, MissionStore, ProgressReceipt, ProgressV1, RecoveryAttemptBinding, RecoveryPolicyLease, RecoveryProgress, SchedulingChoice, SchedulingDecisionRecord, SchedulingSnapshot, SliceInput, TrustedStrategyPolicy, scopesOverlap } from "./mission.js";
import { downstreamDepths, rankSchedulingChoices, schedulingSnapshotDigest, validateSchedulingDecision } from "./scheduling.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const newSecret = () => randomBytes(32).toString("base64url");
const isTerminalRecoveryProgress=(p:RecoveryProgress)=>p.status==="failed"||p.status==="passed";
export class MemoryMissionStore implements MissionStore {
  async createVerificationAttempt():Promise<void>{throw new MissionConflictError("Trusted verification requires PostgreSQL; memory store cannot issue certification attempts");}
  async submitVerification():Promise<never>{throw new MissionConflictError("Trusted verification requires PostgreSQL; memory store cannot certify receipts");}
  async createRecoveryAttempt(_binding:RecoveryAttemptBinding):Promise<void>{throw new MissionConflictError("Trusted recovery requires PostgreSQL; memory store cannot create trusted attempts");}
  async submitRecoveryVerification():Promise<never>{throw new MissionConflictError("Trusted recovery requires PostgreSQL; memory store cannot accept receipts");}
  async getTrustedAttempt():Promise<null>{return null;}
  async getCertificate():Promise<null>{return null;}
  async getCertificateRequest():Promise<null>{return null;}
  async awaitingVerification():Promise<never[]>{return[];}
  private missions = new Map<string, Mission>(); private plans = new Map<string, MissionPlan>(); private slices = new Map<string, MissionSlice>(); private eventsLog: MissionEvent[] = []; private cursor = 0;
  private slots = new Map<number, { digest: string; expires: string; enabled: boolean }>(); private occupied = new Map<string, number>();
  private progress = new Map<string, RecoveryProgress>(); private receipts = new Map<string, GovernorActionV1>(); private snapshots = new Map<string,DecisionSnapshotV1>(); private judgments = new Map<string,JudgmentV1>(); private revisions = new Map<string, number>(); private pendingJudgments = new Map<string,string>(); private leaseBindings = new Map<string,{planDigest:string;policyDigest:string}>(); private lessonRows: (LessonCandidate & { proposedBy: string; reviewer?: string })[] = [];
  async configureCapacity(count:number,digest:string|null,expires:string|null){for(let i=1;i<=6;i++){if(i<=count&&digest&&expires)this.slots.set(i,{digest,expires,enabled:true});else{const old=this.slots.get(i);if(old)this.slots.set(i,{...old,enabled:false});}}}
  private event(id: string, type: string, data: Record<string, unknown>) { this.eventsLog.push({ cursor: ++this.cursor, missionId: id, type, data, createdAt: new Date().toISOString() }); }
  async submit(input: MissionInput) { const id = randomUUID(), now = new Date().toISOString(); const m = { ...input, repository: canonicalRepository(input.repository), acceptance: [...input.acceptance], id, status: "planning" as const, reservedCents: 0, createdAt: now }; this.missions.set(id, m); this.event(id, "mission.submitted", { repository: m.repository, baseSha: input.baseSha }); return m; }
  async recommendPlan(id: string, rows: SliceInput[], recommendedBy: string) { const m = this.mustMission(id); if (m.status !== "planning" || this.plans.has(id)) throw new MissionConflictError("Plan recommendation is closed"); const plan = { missionId: id, slices: rows.map(s => ({ ...s, scopes: [...s.scopes], checks: [...s.checks], dependencies: [...s.dependencies] })), recommendedBy, recommendedAt: new Date().toISOString(), approvedAt: null }; this.plans.set(id, plan); for (const s of rows) this.slices.set(`${id}:${s.id}`, { ...s, missionId: id, status: "waiting_dependency", leaseEpoch: 0, leaseToken: null, leaseExpiresAt: null, candidateSha: null, evidenceRefs: [] }); this.event(id, "plan.recommended", { sliceCount: rows.length, recommendedBy }); return plan; }
  async approvePlan(id: string) { const m = this.mustMission(id), p = this.plans.get(id); if (!p || p.approvedAt || m.status !== "planning") throw new MissionConflictError("Plan cannot be approved"); if (p.slices.reduce((n, s) => n + s.budgetCents, 0) > m.budgetCents) throw new MissionConflictError("Plan budget exceeds mission budget"); p.approvedAt = new Date().toISOString(); m.status = "ready"; for (const s of p.slices) if (!s.dependencies.length) this.slices.get(`${id}:${s.id}`)!.status = "ready"; this.event(id, "plan.approved", { sliceCount: p.slices.length }); return m; }
  async getMission(id: string) { const m = this.missions.get(id); if (!m) return null; return { mission: m, plan: this.plans.get(id) ?? null, slices: [...this.slices.values()].filter(s => s.missionId === id) }; }
  async events(id: string, after: number) { return this.eventsLog.filter(e => e.missionId === id && e.cursor > after); }
  async recordSchedulingDecision(missionId:string,decision:SchedulingDecisionRecord){validateSchedulingDecision(decision);this.mustMission(missionId);this.event(missionId,"scheduling.decision",{...decision});}
  private eligibleSchedulingChoices(policyDigest: string, recoveryPolicyDigest: string, now: Date): { choices: SchedulingChoice[]; freeCapacity: number } {
    const free=[...this.slots.entries()].filter(([slot,x])=>x.enabled&&Date.parse(x.expires)>now.getTime()&&![...this.occupied.values()].includes(slot)).length;
    const choices:SchedulingChoice[]=[];
    for(const s of this.slices.values()){
      if(s.status!=="ready")continue;const plan=this.plans.get(s.missionId),mission=this.missions.get(s.missionId);if(!plan?.approvedAt||!mission||plan.slices.some(d=>s.dependencies.includes(d.id)&&this.slices.get(`${s.missionId}:${d.id}`)?.status!=="verified"))continue;
      if(mission.reservedCents+s.budgetCents>mission.budgetCents)continue;
      const running=[...this.slices.values()].filter(x=>["running","awaiting_verification","unknown","blocked"].includes(x.status)&&this.missions.get(x.missionId)?.repository===mission.repository);
      if(running.some(x=>x.scopes.some(a=>s.scopes.some(b=>scopesOverlap(a,b)))))continue;
      const cohort=scopeCohort(s.scopes),lessons=this.lessonRows.filter(l=>l.status==="promoted"&&l.repository===mission.repository&&l.policyDigest===recoveryPolicyDigest&&l.cohort===cohort&&s.checks.includes(l.fromCheckId)).map(l=>({id:l.id,version:l.lessonVersion,challengeDigest:l.challengeDigest,checkId:l.fromCheckId,strategyId:l.strategyId,policyDigest:l.policyDigest})).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,8);
      choices.push({missionId:s.missionId,sliceId:s.id,repository:mission.repository,planDigest:hash(canonicalJson(plan.slices)),dependencies:[...s.dependencies],scopes:[...s.scopes],budgetCents:s.budgetCents,missionBudgetCents:mission.budgetCents,reservedBudgetCents:mission.reservedCents,downstreamDepth:downstreamDepths(plan.slices).get(s.id)??0,scopeRisk:s.scopes.reduce((n,x)=>n+(/[?*[{]/.test(x)?100:Math.max(0,4-x.split("/").length)),0),lessons});
    }
    return{choices:rankSchedulingChoices(choices).slice(0,32),freeCapacity:free};
  }
  async schedulingSnapshot(_policyDigest:string,recoveryPolicyDigest:string,now=new Date()):Promise<SchedulingSnapshot>{const value=this.eligibleSchedulingChoices(_policyDigest,recoveryPolicyDigest,now),base={freeCapacity:value.freeCapacity,choices:value.choices};return{capturedAt:now.toISOString(),...base,snapshotDigest:schedulingSnapshotDigest(base)};}
  async claim(leaseSeconds: number, policyDigest: string, now = new Date(), recoveryPolicyDigest="", advice?:ClaimAdvice): Promise<LeaseGrant | null> {
    await this.expire(now);
    const fresh=this.eligibleSchedulingChoices(policyDigest,recoveryPolicyDigest,now),unchanged=Boolean(advice?.snapshotDigest&&advice.snapshotDigest===schedulingSnapshotDigest({freeCapacity:fresh.freeCapacity,choices:fresh.choices}));
    const preferred=unchanged&&advice?.status==="selected"?advice.preferredCandidateId:null;
    const candidates=rankSchedulingChoices(fresh.choices).map(choice=>this.slices.get(`${choice.missionId}:${choice.sliceId}`)!).filter(Boolean);
    if(preferred){const index=candidates.findIndex(x=>`${x.missionId}:${x.id}`===preferred);if(index>0)candidates.unshift(...candidates.splice(index,1));}
    for (const s of candidates) {
      const p = this.plans.get(s.missionId)!; if (!p.approvedAt || p.slices.some(d => s.dependencies.includes(d.id) && this.slices.get(`${s.missionId}:${d.id}`)?.status !== "verified")) continue;
      const repository=this.missions.get(s.missionId)!.repository;const running = [...this.slices.values()].filter(x => ["running","awaiting_verification","unknown","blocked"].includes(x.status) && this.missions.get(x.missionId)?.repository===repository);
      if (running.some(x => x.scopes.some(a => s.scopes.some(b => scopesOverlap(a,b))))) continue;
      const slot = [...this.slots.entries()].find(([n,x])=>x.enabled&&new Date(x.expires)>now&&![...this.occupied.values()].includes(n)); if(!slot||!policyDigest) continue;
      const m = this.missions.get(s.missionId)!; if (m.reservedCents + s.budgetCents > m.budgetCents) continue;
      const leaseToken = newSecret(), capabilityToken = newSecret(),planDigest=hash(canonicalJson(p.slices)); s.status = "running"; s.leaseEpoch++; s.leaseToken = `${hash(leaseToken)}:${hash(capabilityToken)}`; s.leaseExpiresAt = new Date(now.getTime() + leaseSeconds*1000).toISOString(); this.occupied.set(`${s.missionId}:${s.id}`,slot[0]);this.leaseBindings.set(`${s.missionId}:${s.id}:${s.leaseEpoch}`,{planDigest,policyDigest:policyDigest+":"+recoveryPolicyDigest}); m.reservedCents += s.budgetCents; m.status = "running";
      this.event(m.id, "slice.claimed", { sliceId: s.id, owner: s.owner, epoch: s.leaseEpoch, scopes: s.scopes, schedulingDecisionId:advice?.decisionId??null, schedulingAdvice: advice?{status:unchanged?advice.status:"stale_fallback",adviceStatus:advice.status,dispatchMayHaveOccurred:advice.dispatchMayHaveOccurred,preferredCandidateId:advice.preferredCandidateId,validatedCandidateId:advice.validatedCandidateId,snapshotDigest:advice.snapshotDigest,modelId:advice.modelId,tokenUsage:advice.tokenUsage,tokenUsageStatus:advice.tokenUsageStatus}:null }); return { mission: m, slice: { ...s, leaseToken: null }, epoch: s.leaseEpoch, leaseToken, capabilityToken, leaseExpiresAt: s.leaseExpiresAt, capacitySlot:slot[0], trustedCheckPolicyDigest:policyDigest, planDigest };
    } return null;
  }
  async heartbeat(missionId:string,id: string, epoch: number, token: string, cap: string, seconds: number) { const s = this.mustRunning(missionId,id, epoch, token, cap); s.leaseExpiresAt = new Date(Date.now()+seconds*1000).toISOString(); this.event(s.missionId, "slice.heartbeat", { sliceId:s.id, epoch }); return { ...s, leaseToken: null }; }
  async complete(missionId:string,id: string, epoch: number, token: string, cap: string, candidateSha: string, evidenceRefs: string[]) { const s = this.mustRunning(missionId,id,epoch,token,cap), m = this.missions.get(s.missionId)!; s.status = "awaiting_verification"; s.candidateSha = candidateSha; s.evidenceRefs=[...evidenceRefs]; s.leaseToken=null; s.leaseExpiresAt=null; this.occupied.delete(`${s.missionId}:${s.id}`);m.status=this.missionStatus(missionId); this.event(m.id,"slice.awaiting_verification",{sliceId:s.id,candidateSha,evidenceRefs}); return { ...s }; }
  async integrate(_missionId:string,_id:string,_candidateSha:string,_policyDigest:string,_evidenceRefs:string[],_integrationEvidenceRef:string,_verifierId:string):Promise<MissionSlice>{throw new MissionConflictError("Independent verifier is unavailable; verification gate remains closed");}
  async reportOutcome(missionId:string,id:string,epoch:number,token:string,cap:string,outcome:"BLOCKED"|"UNKNOWN",reasonCode:string,evidenceRefs:string[]){const s=this.mustRunning(missionId,id,epoch,token,cap);s.status=outcome==="BLOCKED"?"blocked":"unknown";s.leaseToken=null;s.leaseExpiresAt=null;this.missions.get(missionId)!.status=this.missionStatus(missionId);this.event(missionId,`slice.${outcome.toLowerCase()}`,{sliceId:id,epoch,reasonCode,evidenceRefs});return{...s};}
  async recordProgress(p:RecoveryProgress,token:string,cap:string,strategies:Record<string,TrustedStrategyPolicy>,judge?:(snapshot:DecisionSnapshotV1)=>Promise<JudgmentV1>):Promise<ProgressReceipt>{
    if(isTerminalRecoveryProgress(p))throw new MissionConflictError("Trusted recovery requires persisted PostgreSQL attempt evidence");
    // Authenticate before looking up an event ID so a stale or foreign lease
    // cannot use the replay path to read another worker's decision receipt.
    this.mustRunning(p.missionId,p.sliceId,p.leaseEpoch,token,cap);
    const previous=this.receipts.get(p.eventId);if(previous){if(canonicalJson(this.progress.get(p.eventId))!==canonicalJson(p))throw new MissionConflictError("Progress event ID was reused with different content");return{duplicate:true,action:previous,snapshot:this.snapshots.get(p.eventId)!,judgment:this.judgments.get(p.eventId)!};}
    const slice=this.mustRunning(p.missionId,p.sliceId,p.leaseEpoch,token,cap),plan=this.plans.get(p.missionId)!;
    const binding=this.leaseBindings.get(`${p.missionId}:${p.sliceId}:${p.leaseEpoch}`),strategy=strategies[p.strategyId];if(!plan||!binding||binding.planDigest!==p.planDigest||binding.policyDigest!==p.trustedCheckPolicyDigest+":"+p.recoveryPolicyDigest||hash(canonicalJson(plan.slices))!==p.planDigest||p.phase!=="trusted_check"||!slice.checks.includes(p.strategyId)||!strategy||strategy.checkId!==p.checkId||!strategy.targetCheckIds.includes(p.targetCheckId))throw new MissionConflictError("Progress is outside its lease policy");
    const key=`${p.missionId}:${p.sliceId}:${p.leaseEpoch}`;
    if(this.pendingJudgments.has(key))throw new MissionConflictError("A prior judgment is unresolved; blind retry is forbidden");
    const ordinal=(this.revisions.get(key)??0)+1;if(p.ordinal!==ordinal)throw new MissionConflictError("Progress ordinal is stale or has a gap");
    if(p.ordinal>1){
      const previous=[...this.progress.entries()].find(([,value])=>value.missionId===p.missionId&&value.sliceId===p.sliceId&&value.leaseEpoch===p.leaseEpoch&&value.ordinal===p.ordinal-1);
      const previousAction=previous?this.receipts.get(previous[0]):undefined;
      const authorizedStrategy=previous&&previousAction?.action==="change_strategy"?previousAction.strategyId:previous&&previousAction?.action==="continue"&&previous[1].status==="started"?previous[1].strategyId:null;
      if(!authorizedStrategy||p.strategyId!==authorizedStrategy)throw new MissionConflictError("Progress strategy is not the prior Governor-authorized action");
    }
    const mission=this.missions.get(p.missionId)!,cohort=scopeCohort(slice.scopes);
    if(!cohort)throw new MissionConflictError("A stable scope cohort is unavailable for this lease");
    const tried=new Set([...this.progress.values()].filter(x=>x.missionId===p.missionId&&x.sliceId===p.sliceId&&x.leaseEpoch===p.leaseEpoch).map(x=>x.strategyId));
    const applicable=(id:string)=>Boolean(strategies[id]?.targetCheckIds.includes(p.targetCheckId)&&(strategies[id]?.scopeClasses.includes("*")||strategies[id]?.scopeClasses.includes(cohort)));
    const next=p.status==="failed"&&tried.size<2?slice.checks.find(x=>x!==p.strategyId&&!tried.has(x)&&applicable(x))??null:null;
    const available=slice.checks.filter(applicable).map(id=>({id,policy:strategies[id]!}));
    const snapshot:DecisionSnapshotV1={version:"orloom.decision-snapshot.v1",missionId:p.missionId,sliceId:p.sliceId,leaseEpoch:p.leaseEpoch,revision:ordinal,planDigest:p.planDigest,trustedCheckPolicyDigest:p.trustedCheckPolicyDigest,recoveryPolicyDigest:p.recoveryPolicyDigest,leaseExpiresAt:slice.leaseExpiresAt!,missionBudgetCents:mission.budgetCents,sliceBudgetCents:slice.budgetCents,reservedBudgetCents:mission.reservedCents,reportedUsage:{...p.counters},evidenceRefs:[...p.evidenceRefs],eventId:p.eventId,targetCheckId:p.targetCheckId,status:p.status,reasonCode:p.reasonCode,strategyId:p.strategyId,checkId:p.checkId,triedStrategies:[...tried,p.strategyId],alternatives:next?available.filter(x=>!tried.has(x.id)&&x.id!==p.strategyId):[],lessonIds:[],lessonBindings:[],preferredStrategyId:null};
    this.revisions.set(key,ordinal);
    this.pendingJudgments.set(key,p.eventId);
    let judgment:JudgmentV1;
    try { judgment=judge?await judge(snapshot):deterministicRecovery(snapshot); }
    catch { this.quarantineUnknown(p,slice,mission,snapshot);throw new MissionConflictError("Judgment outcome is unknown; lease remains quarantined"); }
    const terminalStatus=p.status==="blocked"||p.status==="unknown";
    if(judgment.snapshotDigest!==hash(canonicalJson(snapshot))||judgment.policyDigest!==p.recoveryPolicyDigest||(terminalStatus&&judgment.answer!=="escalate")||judgment.answer==="change_strategy"&&!snapshot.alternatives.some(x=>x.id===judgment.strategyId&&x.id!==p.strategyId&&x.policy.checkId===judgment.checkId)||judgment.answer!=="change_strategy"&&(judgment.strategyId!==null||judgment.checkId!==null)||p.status==="failed"&&judgment.answer==="continue"){
      this.quarantineUnknown(p,slice,mission,snapshot);
      throw new MissionConflictError("Judgment is outside the fenced recovery policy; lease remains quarantined");
    }
    try {
      const current=this.mustRunning(p.missionId,p.sliceId,p.leaseEpoch,token,cap);
      if(this.pendingJudgments.get(key)!==p.eventId
        ||this.revisions.get(key)!==snapshot.revision
        ||current.leaseExpiresAt!==snapshot.leaseExpiresAt
        ||mission.budgetCents!==snapshot.missionBudgetCents
        ||current.budgetCents!==snapshot.sliceBudgetCents
        ||mission.reservedCents!==snapshot.reservedBudgetCents
        ||canonicalJson(p.counters)!==canonicalJson(snapshot.reportedUsage)
        ||canonicalJson(p.evidenceRefs)!==canonicalJson(snapshot.evidenceRefs)){
        throw new MissionConflictError("Judgment snapshot context changed");
      }
    } catch {
      this.quarantineUnknown(p,slice,mission,snapshot);
      throw new MissionConflictError("Judgment fence changed; lease remains quarantined");
    }
    const chosen=judgment.strategyId?strategies[judgment.strategyId]!:strategy;
    const action:GovernorActionV1={version:"orloom.governor-action.v1",eventId:p.eventId,revision:ordinal,action:judgment.answer,strategyId:judgment.strategyId,checkId:judgment.checkId,expectedSignal:chosen.expectedSignal,policyVersion:judgment.policyVersion,policyDigest:judgment.policyDigest,lessonIds:snapshot.lessonIds,lessonBindings:snapshot.lessonBindings};
    this.progress.set(p.eventId,p);this.receipts.set(p.eventId,action);this.snapshots.set(p.eventId,snapshot);this.judgments.set(p.eventId,judgment);this.revisions.set(key,ordinal);this.event(p.missionId,"slice.progress",{sliceId:p.sliceId,epoch:p.leaseEpoch,eventId:p.eventId,ordinal:p.ordinal,revision:ordinal,phase:p.phase,status:p.status,reasonCode:p.reasonCode,targetCheckId:p.targetCheckId,checkId:p.checkId,strategyId:p.strategyId,evidenceRefs:p.evidenceRefs,snapshotDigest:judgment.snapshotDigest,judgmentSource:judgment.source,action:action.action,nextStrategyId:judgment.strategyId});
    if(action.action==="escalate"||action.action==="request_replan"){
      slice.status=p.status==="blocked"?"blocked":"unknown";
      slice.leaseToken=null;
      slice.leaseExpiresAt=null;
      mission.status=this.missionStatus(p.missionId);
      if(action.action==="request_replan")this.event(p.missionId,"sol.replan_requested",{sliceId:p.sliceId,epoch:p.leaseEpoch,eventId:p.eventId,reasonCode:p.reasonCode});
    }
    this.pendingJudgments.delete(key);
    if(p.status==="passed")this.maybeLesson(p,mission.repository,cohort,strategy);
    return{duplicate:false,action,snapshot,judgment};
  }
  private maybeLesson(p:RecoveryProgress,repository:string,cohort:string,strategy:TrustedStrategyPolicy){
    const episodes=new Map<string,{failure:string;success:string}>();
    for(const[successId,success]of this.progress.entries()){
      const successMission=this.missions.get(success.missionId);
      const successSlice=this.slices.get(`${success.missionId}:${success.sliceId}`);
      const successCohort=scopeCohort(successSlice?.scopes);
      if(successMission?.repository!==repository||!successCohort||successCohort!==cohort||success.status!=="passed"
        ||success.strategyId!==p.strategyId||success.targetCheckId!==p.targetCheckId
        ||success.recoveryPolicyDigest!==p.recoveryPolicyDigest
        ||success.trustedCheckPolicyDigest!==p.trustedCheckPolicyDigest
        ||!this.receipts.has(successId))continue;

      const successObservation={
        eventId:successId,repository:successMission.repository,missionId:success.missionId,sliceId:success.sliceId,
        leaseEpoch:success.leaseEpoch,ordinal:success.ordinal,status:success.status,
        decisionStatus:"committed",targetCheckId:success.targetCheckId,strategyId:success.strategyId,
        trustedCheckPolicyDigest:success.trustedCheckPolicyDigest,recoveryPolicyDigest:success.recoveryPolicyDigest,
        cohort:successCohort,
      };
      for(const[failureId,failure]of this.progress.entries()){
        if(failure.missionId!==success.missionId||failure.sliceId!==success.sliceId||failure.leaseEpoch!==success.leaseEpoch
          ||!this.receipts.has(failureId))continue;
        const failureSlice=this.slices.get(`${failure.missionId}:${failure.sliceId}`);
        const failureCohort=scopeCohort(failureSlice?.scopes);
        if(!failureCohort)continue;
        const failureObservation={
          eventId:failureId,repository:this.missions.get(failure.missionId)?.repository??"",missionId:failure.missionId,sliceId:failure.sliceId,
          leaseEpoch:failure.leaseEpoch,ordinal:failure.ordinal,status:failure.status,
          decisionStatus:"committed",targetCheckId:failure.targetCheckId,strategyId:failure.strategyId,
          trustedCheckPolicyDigest:failure.trustedCheckPolicyDigest,recoveryPolicyDigest:failure.recoveryPolicyDigest,
          cohort:failureCohort,
        };
        if(eligibleLessonPair(failureObservation,successObservation)){
          episodes.set(lessonEpisodeKey(successObservation),{failure:failureId,success:successId});
        }
      }
    }
    if(episodes.size<2)return;
    const ids=[...episodes.values()].flatMap(x=>[x.failure,x.success]).sort();
    const fromCheckId=p.targetCheckId,policyVersion=strategy.version,policyDigest=p.recoveryPolicyDigest;
    const metric="trusted_check_pass_rate" as const,direction="increase" as const,baseline={failed:2,observed:2},outcome={passed:2,observed:2};
    const challenge=lessonChallengeDigest({repository,cohort,fromCheckId,strategyId:p.strategyId,policyVersion,policyDigest,evidenceEventIds:ids,metric,direction,baseline,outcome});
    const latestVersion=Math.max(0,...this.lessonRows.filter(x=>x.repository===repository&&x.cohort===cohort&&x.fromCheckId===fromCheckId&&x.strategyId===p.strategyId).map(x=>x.lessonVersion));
    if(this.lessonRows.some(x=>x.repository===repository&&x.cohort===cohort&&x.fromCheckId===fromCheckId&&x.strategyId===p.strategyId&&x.status!=="withdrawn"))return;
    const id=randomUUID();
    this.lessonRows.push({id,lessonVersion:latestVersion+1,repository,cohort,fromCheckId,strategyId:p.strategyId,rule:lessonRule({fromCheckId,strategyId:p.strategyId,cohort}),metric,direction,baseline,outcome,policyVersion,policyDigest,status:"candidate",challengeDigest:challenge,evidenceEventIds:ids,proposedBy:`worker:${p.missionId}:${p.sliceId}:${p.leaseEpoch}`});
    this.event(p.missionId,"lesson.candidate",{lessonId:id,lessonVersion:latestVersion+1,cohort,fromCheckId,strategyId:p.strategyId,evidenceEventIds:ids,metric:"trusted_check_pass_rate",direction:"increase",challengeDigest:challenge});
  }
  private quarantineUnknown(p:RecoveryProgress,slice:MissionSlice,mission:Mission,snapshot:DecisionSnapshotV1){
    this.pendingJudgments.delete(`${p.missionId}:${p.sliceId}:${p.leaseEpoch}`);
    this.progress.set(p.eventId,p);
    this.snapshots.set(p.eventId,snapshot);
    this.revisions.set(`${p.missionId}:${p.sliceId}:${p.leaseEpoch}`,snapshot.revision);
    slice.status="unknown";
    slice.leaseToken=null;
    slice.leaseExpiresAt=null;
    mission.status=this.missionStatus(p.missionId);
    this.event(p.missionId,"slice.judgment_unknown",{sliceId:p.sliceId,epoch:p.leaseEpoch,eventId:p.eventId});
  }
  async lessons(missionId:string){const repository=this.missions.get(missionId)?.repository;if(!repository)return[];return this.lessonRows.filter(x=>x.repository===repository).map(({proposedBy:_p,reviewer:_r,...v})=>({...v}));}
  async getLesson(lessonId:string){const row=this.lessonRows.find(x=>x.id===lessonId);if(!row)return null;const{proposedBy:_p,reviewer:_r,...value}=row;return{...value};}
  async recoveryPolicyLease(missionId:string,id:string,epoch:number,token:string,cap:string):Promise<RecoveryPolicyLease>{const s=this.mustRunning(missionId,id,epoch,token,cap),binding=this.leaseBindings.get(`${missionId}:${id}:${epoch}`);if(!binding)throw new MissionConflictError("Recovery policy lease is unavailable");const p=this.plans.get(missionId)!;return{planDigest:binding.planDigest,trustedCheckPolicyDigest:binding.policyDigest.split(":")[0]!,recoveryPolicyDigest:binding.policyDigest.split(":")[1]??""};}
  async promoteLesson(_id:string,_challengeDigest:string,_reviewer:string):Promise<LessonCandidate>{
    throw new MissionConflictError("Independent lesson verification is unavailable; candidate remains unpromoted");
  }
  async expire(now = new Date(), limit = 100) { let n=0; const expired=[...this.slices.values()].filter(s=>s.status==="running"&&s.leaseExpiresAt&&new Date(s.leaseExpiresAt)<=now).sort((a,b)=>a.leaseExpiresAt!.localeCompare(b.leaseExpiresAt!)).slice(0,Math.max(1,Math.min(limit,1000))); for (const s of expired) { s.status="unknown";s.leaseToken=null;s.leaseExpiresAt=null; const m=this.missions.get(s.missionId)!;m.status=this.missionStatus(m.id);this.event(m.id,"slice.lease_expired_unknown",{sliceId:s.id,epoch:s.leaseEpoch});n++; } return n; }
  private missionStatus(id:string):Mission["status"]{const states=[...this.slices.values()].filter(x=>x.missionId===id).map(x=>x.status);return states.length>0&&states.every(x=>x==="verified")?"verified":states.includes("unknown")?"unknown":states.includes("blocked")?"blocked":states.includes("running")?"running":states.includes("awaiting_verification")?"awaiting_verification":"ready";}
  private mustMission(id:string){const m=this.missions.get(id);if(!m)throw new MissionConflictError("Mission not found");return m;}
  private mustRunning(missionId:string,id:string,epoch:number,token:string,cap:string){ const s=this.slices.get(`${missionId}:${id}`),slot=s?this.slots.get(this.occupied.get(`${s.missionId}:${s.id}`)??-1):undefined;if(!s||s.status!=="running"||!slot||!slot.enabled||new Date(slot.expires)<=new Date()||s.leaseEpoch!==epoch||!s.leaseExpiresAt||new Date(s.leaseExpiresAt)<=new Date()||s.leaseToken!==`${hash(token)}:${hash(cap)}`)throw new MissionConflictError("Lease is stale, expired, or unauthorized");return s; }
}
