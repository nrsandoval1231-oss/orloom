import { loadConfig } from "../../../packages/config/src/config.js";
import { MemoryJobStore } from "../../../packages/contracts/src/memory-store.js";
import { PostgresJobStore } from "../../../packages/contracts/src/postgres-store.js";
import { createControlPlane } from "./server.js";
import { MemoryMissionStore } from "../../../packages/contracts/src/memory-mission-store.js";
import { SqlMissionStore } from "../../../packages/contracts/src/sql-mission-store.js";
import { startLeaseReconciler } from "../../../packages/governor/src/lease-reconciler.js";
import { TrustedCheckCoordinator } from "../../../packages/governor/src/governor.js";
import { createTrustedVerificationRunner, getCheckPolicy, getCheckAttemptLifetimeMs } from "../../verifier/src/index.js";

const config = loadConfig(process.env);
let jobs: MemoryJobStore | PostgresJobStore;
let missions;
try { jobs = config.mode === "cloud" ? await PostgresJobStore.connect(config.databaseUrl!) : new MemoryJobStore(); }
catch { process.stderr.write("Orloom cloud startup failed: database initialization or readiness check failed.\n"); process.exit(1); }
try {
  missions = config.mode === "cloud" ? new SqlMissionStore(jobs as PostgresJobStore) : new MemoryMissionStore();
  await missions.configureCapacity(config.capacitySlots ?? 0, config.capacityEvidenceDigest ?? null, config.capacityEvidenceExpiresAt ?? null);
} catch { process.stderr.write("Orloom capacity configuration failed closed.\n"); process.exit(1); }
let stopLeaseReconciler: () => Promise<void>;
try {
  stopLeaseReconciler = await startLeaseReconciler(missions, { onError: () => process.stderr.write("Orloom lease reconciliation failed; claims will remain fail-closed.\n") });
} catch { process.stderr.write("Orloom lease reconciliation startup failed closed.\n"); process.exit(1); }
let trustedChecks:TrustedCheckCoordinator|undefined;
let verificationTimer:ReturnType<typeof setInterval>|undefined;
let verificationTask:Promise<void>|undefined;
let shuttingDown=false;
async function reconcileVerification():Promise<void>{
  if(shuttingDown||verificationTask)return;
  verificationTask=(async()=>{try{await trustedChecks?.reconcile(1);await trustedChecks?.expire();}catch{process.stderr.write("Orloom verification reconciliation failed closed.\n");}})();
  try{await verificationTask;}finally{verificationTask=undefined;}
}
try {
  const runner=await createTrustedVerificationRunner(process.env);
  if(runner&&missions instanceof SqlMissionStore&&config.trustedCheckPolicyDigest&&config.trustedVerifierId&&config.trustedVerifierImageDigest){
    const checkId=process.env.ORLOOM_VERIFIER_CHECK_ID??"node-validate-syntax",policy=getCheckPolicy(checkId,process.env.ORLOOM_VERIFIER_IMAGE,config.trustedVerifierImageDigest);
    if(config.trustedCheckPolicy?.includes(checkId)&&policy.imageDigest===config.trustedVerifierImageDigest&&(!config.trustedVerificationPolicyVersion||config.trustedVerificationPolicyVersion===policy.version)){
      trustedChecks=new TrustedCheckCoordinator(missions,runner,{imageDigest:policy.imageDigest,verifierId:config.trustedVerifierId,policyDigest:policy.digest,leasePolicyDigest:config.trustedCheckPolicyDigest,policyVersion:policy.version,allowedChecks:[checkId],attemptLifetimeMs:getCheckAttemptLifetimeMs(checkId)});
      verificationTimer=setInterval(()=>{void reconcileVerification();},5_000);verificationTimer.unref();
    }
  }
}catch{process.stderr.write("Orloom trusted verifier configuration failed closed.\n");process.exit(1);}
const controls=createControlPlane(config,jobs,missions,undefined,trustedChecks);
const host = config.mode === "cloud" ? (process.env.ORLOOM_BIND ?? "0.0.0.0") : "127.0.0.1";
controls.listen(config.port, host, () => process.stdout.write(`Orloom ${config.mode} control plane listening on ${host}:${config.port}\n`));
async function shutdown():Promise<void>{
  if(shuttingDown)return;
  shuttingDown=true;
  if(verificationTimer)clearInterval(verificationTimer);
  await verificationTask;
  await stopLeaseReconciler();
  await new Promise<void>((resolve)=>controls.close(()=>resolve()));
  if(jobs instanceof PostgresJobStore)await jobs.close();
  process.exit(0);
}
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void shutdown().catch(()=>{process.stderr.write("Orloom shutdown did not complete cleanly.\n");process.exit(1);}); });
