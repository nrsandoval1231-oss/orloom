import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { randomBytes } from "node:crypto";
import { Config } from "../../../packages/config/src/config.js";
import { InputValidationError, JobStore } from "../../../packages/contracts/src/job.js";
import { MissionConflictError, MissionStore, MissionValidationError, RecoveryProgress } from "../../../packages/contracts/src/mission.js";
import { MemoryMissionStore } from "../../../packages/contracts/src/memory-mission-store.js";
import { MissionGovernor, RecoveryJudgmentAdapter, TrustedCheckCoordinator } from "../../../packages/governor/src/governor.js";
import { workerLeaseContract } from "../../../packages/contracts/src/worker-protocol.js";
import { createHash } from "node:crypto";

class RequestTooLargeError extends Error {}

function page(configured: boolean, mode: Config["mode"]) { return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Orloom</title><main><h1>Orloom</h1><p id="state">${mode === "cloud" ? "Mission control plane. No worker capacity is active unless attested by the operator." : "Local mission control plane. Worker execution is disabled by default."} ${configured ? "Owner session configured." : "Set ORLOOM_SESSION_TOKEN to enable submissions."}</p><form id="login"><label>Owner session token <input type="password" autocomplete="current-password" required></label><button ${configured ? "" : "disabled"}>Unlock</button></form><section><h2>New mission</h2><form id="mission"><label>Repository <input name="repository" placeholder="owner/repo" required></label><label>Immutable base SHA <input name="baseSha" pattern="[0-9a-fA-F]{40}" required></label><label>Objective <textarea name="objective" required></textarea></label><label>Acceptance criteria (one per line) <textarea name="acceptance" required></textarea></label><label>Budget (cents) <input name="budgetCents" type="number" min="1" required></label><button>Create mission</button></form></section><section id="planner" hidden><h2>Owner-authored plan recommendation</h2><form id="plan"><label>Slice objective <textarea name="objective" required></textarea></label><label>Ownership label <input name="owner" value="core" required></label><label>Owned paths (one per line) <textarea name="scopes" required></textarea></label><label>Expected check identifiers (one per line) <textarea name="checks"></textarea></label><label>Slice budget (cents) <input name="budgetCents" type="number" min="0" required></label><button>Save recommendation</button></form><button id="approve" hidden>Owner approve this plan</button></section><section><h2>Mission status</h2><pre id="result" aria-live="polite">No mission loaded.</pre><button id="refresh" hidden>Refresh mission and event history</button></section><section><h2>Operational lessons</h2><div id="lessons" aria-live="polite"></div></section></main><script>
const state=document.querySelector('#state'), result=document.querySelector('#result'), planner=document.querySelector('#planner'), lessonList=document.querySelector('#lessons');let currentId=null;
async function json(path,method='GET',bodyValue){const r=await fetch(path,{method,headers:bodyValue?{'content-type':'application/json'}:{},body:bodyValue?JSON.stringify(bodyValue):undefined});if(!r.ok)throw Error('Request failed: '+r.status);return r.status===204?null:r.json()}
async function refresh(){if(!currentId)return;const [m,events,lessons]=await Promise.all([json('/api/missions/'+currentId),json('/api/missions/'+currentId+'/events'),json('/api/missions/'+currentId+'/lessons')]);result.textContent=JSON.stringify({mission:m.mission,plan:m.plan,slices:m.slices,events},null,2);lessonList.replaceChildren();for(const l of lessons){const row=document.createElement('p');row.textContent=l.status+': '+l.fromCheckId+' → '+l.strategyId+' v'+l.lessonVersion+'; provenance '+l.evidenceEventIds.length+' progress events; independent validation unavailable';lessonList.append(row)}document.querySelector('#refresh').hidden=false}
document.querySelector('#login').onsubmit=async e=>{e.preventDefault();try{await json('/session','POST',{token:e.target.querySelector('input').value});state.textContent='Owner session unlocked.';e.target.reset()}catch{state.textContent='Could not unlock session.'}};
document.querySelector('#mission').onsubmit=async e=>{e.preventDefault();try{const f=Object.fromEntries(new FormData(e.target));const m=await json('/api/missions','POST',{repository:f.repository,baseSha:f.baseSha,objective:f.objective,acceptance:f.acceptance.split(/\r?\n/).filter(Boolean),budgetCents:Number(f.budgetCents)});currentId=m.id;planner.hidden=false;await refresh()}catch(err){result.textContent=err.message}};
document.querySelector('#plan').onsubmit=async e=>{e.preventDefault();try{const f=Object.fromEntries(new FormData(e.target));await json('/api/missions/'+currentId+'/plan','POST',{recommendedBy:'owner-authored',slices:[{id:'slice-1',objective:f.objective,dependencies:[],owner:f.owner,scopes:f.scopes.split(/\r?\n/).filter(Boolean),checks:f.checks.split(/\r?\n/).filter(Boolean),budgetCents:Number(f.budgetCents)}]});document.querySelector('#approve').hidden=false;await refresh()}catch(err){result.textContent=err.message}};
document.querySelector('#approve').onclick=async()=>{try{await json('/api/missions/'+currentId+'/approve','POST',{});document.querySelector('#approve').hidden=true;await refresh()}catch(err){result.textContent=err.message}};document.querySelector('#refresh').onclick=()=>refresh();
</script></html>`; }

function safeEqual(a: string, b: string) { const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
function cookie(req: IncomingMessage, key: string) { return req.headers.cookie?.split(";").map(x => x.trim()).find(x => x.startsWith(`${key}=`))?.slice(key.length + 1); }
async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 256_000) throw new RequestTooLargeError(); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
function send(res: ServerResponse, status: number, data: string, type = "application/json") { res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "x-content-type-options": "nosniff", "cache-control": "no-store" }); res.end(data); }
function parseJson(raw: Buffer): unknown { try { return JSON.parse(raw.toString()); } catch { throw new InputValidationError("invalid json"); } }

export function createControlPlane(config: Config, jobs: JobStore, missionStore: MissionStore = new MemoryMissionStore(), judgmentAdapter?: RecoveryJudgmentAdapter, trustedChecks?:TrustedCheckCoordinator) {
  const sessions = new Map<string, number>();
  const cloud = config.mode === "cloud";
  const sessionMaxAge = (config as Config & { sessionTtlSeconds?: number }).sessionTtlSeconds ?? 8 * 60 * 60;
  const limitsReady=(config.workerMaxProviderCalls??0)>0&&(config.workerMaxInputTokens??0)>0&&(config.workerMaxOutputTokens??0)>0&&(config.workerMaxWallSeconds??0)>0&&(config.workerAllowedProviders?.length??0)>0&&(config.workerAllowedModels?.length??0)>0;
  const governor = new MissionGovernor(missionStore, { maxLanes: config.maxLanes ?? 6, capacitySlots: config.capacitySlots ?? 0, leaseSeconds: 300, trustedCheckPolicyDigest: config.trustedCheckPolicyDigest ?? null, recoveryPolicyDigest:config.recoveryPolicyDigest??null,trustedCheckPolicy:config.trustedCheckPolicy??[],trustedStrategies:config.trustedStrategies??{}, executionConfigured: limitsReady,progressLimits:{maxProviderCalls:config.workerMaxProviderCalls??0,maxInputTokens:config.workerMaxInputTokens??0,maxOutputTokens:config.workerMaxOutputTokens??0,maxWallSeconds:config.workerMaxWallSeconds??0} }, judgmentAdapter);
  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") return send(res, 200, page(Boolean(config.sessionToken), config.mode), "text/html");
      if (req.method === "GET" && req.url === "/health") {
        const ready = !cloud || ("ready" in jobs && typeof jobs.ready === "function" && await jobs.ready());
        return send(res, ready ? 200 : 503, JSON.stringify({ status: ready ? "ok" : "unavailable", mode: config.mode, liveExecution: false }));
      }
      const workerPath = req.url?.startsWith("/api/worker/") ?? false;
      const machinePath = workerPath;
      if (req.method === "POST" && cloud && !machinePath && !validWriteOrigin(req, config)) return send(res, 403, JSON.stringify({ error: "Forbidden" }));
      if (req.method === "POST" && req.url === "/session") {
        const raw = await body(req);
        let input: unknown;
        try { input = JSON.parse(raw.toString()); } catch { return send(res, 400, JSON.stringify({ error: "Invalid JSON" })); }
        const token = typeof input === "object" && input && "token" in input && typeof input.token === "string" ? input.token : "";
        if (!config.sessionToken || !safeEqual(token, config.sessionToken)) return send(res, 401, JSON.stringify({ error: "Unauthorized" }));
        const sessionId = cloud ? randomBytes(32).toString("base64url") : config.sessionToken;
        if (cloud) sessions.set(sessionId, Date.now() + sessionMaxAge * 1000);
        const attributes = `HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionMaxAge}${cloud ? "; Secure" : ""}`;
        res.writeHead(204, { "set-cookie": `orloom_session=${encodeURIComponent(sessionId)}; ${attributes}`, "cache-control": "no-store" });
        return res.end();
      }
      if (req.method === "POST" && req.url === "/api/jobs") {
        if (!validSession(req, config, sessions)) return send(res, 401, JSON.stringify({ error: "Unauthorized" }));
        const raw = await body(req);
        let input: unknown;
        try { input = JSON.parse(raw.toString()); } catch { return send(res, 400, JSON.stringify({ error: "Invalid JSON" })); }
        if (typeof input !== "object" || !input || !("repository" in input) || !("task" in input) || typeof input.repository !== "string" || typeof input.task !== "string") return send(res, 400, JSON.stringify({ error: "repository and task are required" }));
        const job = await jobs.submit({ repository: input.repository, task: input.task });
        return send(res, 201, JSON.stringify(job));
      }
      if (req.method === "POST" && req.url === "/api/missions") {
        if (!validSession(req, config, sessions)) return send(res, 401, JSON.stringify({ error: "Unauthorized" }));
        const input = parseJson(await body(req)); if (!input || typeof input !== "object" || Array.isArray(input)) return send(res,400,JSON.stringify({error:"Invalid mission input"}));const v=input as Record<string,unknown>;
        const mission = await governor.submit({repository:v.repository as string,baseSha:v.baseSha as string,objective:v.objective as string,acceptance:v.acceptance as string[],budgetCents:v.budgetCents as number}); return send(res,201,JSON.stringify(mission));
      }
      if(req.method==="POST"&&req.url?.match(/^\/api\/lessons\/([^/?]+)\/(challenge|promote)$/)){
        if(!validSession(req,config,sessions))return send(res,401,JSON.stringify({error:"Unauthorized"}));
        const match=req.url.match(/^\/api\/lessons\/([^/?]+)\/(challenge|promote)$/)!,id=decodeURIComponent(match[1]!);
        if(match[2]==="challenge"){await body(req);if(!trustedChecks)return send(res,503,JSON.stringify({error:"Independent lesson challenger is unavailable"}));return send(res,200,JSON.stringify(await trustedChecks.challengeLesson(id)));}
        const raw=parseJson(await body(req));if(!raw||typeof raw!=="object"||Array.isArray(raw)||typeof (raw as Record<string,unknown>).challengeDigest!=="string"||Object.keys(raw).length!==1)return send(res,400,JSON.stringify({error:"Invalid accepted challenge reference"}));return send(res,200,JSON.stringify(await governor.promoteLesson(id,(raw as {challengeDigest:string}).challengeDigest)));
      }
      const missionRoute = req.url?.split("?",1)[0]?.match(/^\/api\/missions\/([^/?]+)(?:\/(plan|approve|events|lessons))?$/);
      if (missionRoute && req.method === "POST") {
        if (!validSession(req, config, sessions)) return send(res,401,JSON.stringify({error:"Unauthorized"}));
        const id=decodeURIComponent(missionRoute[1]!);
        if(missionRoute[2]==="plan"){const input=parseJson(await body(req)) as {slices?:unknown[]}|null;if(!input||!Array.isArray(input.slices))return send(res,400,JSON.stringify({error:"Invalid plan recommendation"}));const slices=input.slices.map(raw=>{if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new MissionValidationError("invalid slice record");const v=raw as Record<string,unknown>;return{id:v.id as string,objective:v.objective as string,dependencies:v.dependencies as string[],owner:v.owner as string,scopes:v.scopes as string[],checks:v.checks as string[],budgetCents:v.budgetCents as number};});return send(res,201,JSON.stringify(await governor.recommend(id,slices,"owner-session")));}
        if(missionRoute[2]==="approve"){await body(req);return send(res,200,JSON.stringify(await governor.approve(id)));}
      }
      if (missionRoute && req.method === "GET") {
        if (!validSession(req, config, sessions)) return send(res,401,JSON.stringify({error:"Unauthorized"}));
        const id=decodeURIComponent(missionRoute[1]!);
        if(missionRoute[2]==="events"){const after=Number(new URL(req.url!,"http://local").searchParams.get("after")??"0");if(!Number.isSafeInteger(after)||after<0)return send(res,400,JSON.stringify({error:"Invalid event cursor"}));return send(res,200,JSON.stringify(await governor.events(id,after)));}
        if(missionRoute[2]==="lessons"){return send(res,200,JSON.stringify(await governor.lessons(id)));}
        const record=await governor.get(id);return record?send(res,200,JSON.stringify(record)):send(res,404,JSON.stringify({error:"Not found"}));
      }
      const certificateRoute=req.url?.split("?",1)[0]?.match(/^\/api\/missions\/([^/?]+)\/slices\/([^/?]+)\/checks\/([^/?]+)\/certificate$/);
      if(certificateRoute&&req.method==="GET"){
        if(!validSession(req,config,sessions))return send(res,401,JSON.stringify({error:"Unauthorized"}));
        if(!trustedChecks)return send(res,503,JSON.stringify({error:"Trusted verification is not configured"}));
        const certificate=await trustedChecks.getCertificate(decodeURIComponent(certificateRoute[1]!),decodeURIComponent(certificateRoute[2]!),decodeURIComponent(certificateRoute[3]!));
        return certificate?send(res,200,JSON.stringify(certificate)):send(res,404,JSON.stringify({error:"Certificate not found"}));
      }
      if(workerPath&&req.method==="GET"){
        const m=req.url?.match(/^\/api\/worker\/missions\/([^/]+)\/slices\/([^/]+)\/recovery-policy$/);if(m){const epoch=Number(req.headers["x-orloom-lease-epoch"]),auth=req.headers.authorization,cap=typeof auth==="string"?auth.replace(/^Bearer\s+/i,""):"",leaseToken=req.headers["x-orloom-lease-token"];if(!cap||typeof leaseToken!=="string"||!leaseToken)return send(res,401,JSON.stringify({error:"Unauthorized"}));if(!Number.isSafeInteger(epoch)||epoch<1)return send(res,400,JSON.stringify({error:"Invalid lease identity"}));return send(res,200,JSON.stringify(await governor.recoveryPolicy(decodeURIComponent(m[1]!),decodeURIComponent(m[2]!),epoch,leaseToken,cap)));}
      }
      if (workerPath && req.method === "POST") {
        const recoveryCheck=req.url?.match(/^\/api\/worker\/missions\/([^/]+)\/slices\/([^/]+)\/recovery-check$/);
        if(recoveryCheck){const epoch=Number(req.headers["x-orloom-lease-epoch"]),auth=req.headers.authorization,cap=typeof auth==="string"?auth.replace(/^Bearer\s+/i,""):"",leaseToken=req.headers["x-orloom-lease-token"];if(!cap||typeof leaseToken!=="string"||!leaseToken)return send(res,401,JSON.stringify({error:"Unauthorized"}));if(!Number.isSafeInteger(epoch)||epoch<1)return send(res,400,JSON.stringify({error:"Invalid lease identity"}));if(!trustedChecks)return send(res,503,JSON.stringify({error:"Trusted recovery is not configured"}));const raw=parseJson(await body(req));if(!raw||typeof raw!=="object"||Array.isArray(raw))return send(res,400,JSON.stringify({error:"Invalid recovery attempt"}));const value=raw as Record<string,unknown>;if(typeof value.candidateSha!=="string"||typeof value.targetCheckId!=="string"||typeof value.strategyId!=="string"||!Number.isSafeInteger(value.ordinal)||Object.keys(value).some(key=>!["candidateSha","targetCheckId","strategyId","ordinal"].includes(key)))return send(res,400,JSON.stringify({error:"Invalid recovery attempt"}));const result=await governor.runTrustedRecoveryAttempt(trustedChecks,{missionId:decodeURIComponent(recoveryCheck[1]!),sliceId:decodeURIComponent(recoveryCheck[2]!),epoch,leaseToken,capabilityToken:cap,candidateSha:value.candidateSha,targetCheckId:value.targetCheckId,strategyId:value.strategyId,ordinal:Number(value.ordinal)});return send(res,200,JSON.stringify(result));}
        if(req.url==="/api/worker/claim"){if(!config.workerToken||!safeEqual(req.headers.authorization?.replace(/^Bearer\s+/i,"")??"",config.workerToken))return send(res,401,JSON.stringify({error:"Unauthorized"}));await body(req);const grant=await governor.claim();if(!grant)return send(res,204,"");const record=await governor.get(grant.mission.id);if(!record?.plan)return send(res,409,JSON.stringify({error:"Plan unavailable"}));const planDigest=createHash("sha256").update(JSON.stringify(record.plan.slices)).digest("hex");const envelope=workerLeaseContract({mission:{id:grant.mission.id,repository:grant.mission.repository,baseSha:grant.mission.baseSha,objective:grant.mission.objective,acceptance:grant.mission.acceptance},slice:{id:grant.slice.id,objective:grant.slice.objective,dependencies:grant.slice.dependencies,owner:grant.slice.owner,scopes:grant.slice.scopes,checks:grant.slice.checks},capacitySlot:grant.capacitySlot,leaseEpoch:grant.epoch,leaseToken:grant.leaseToken,capabilityToken:grant.capabilityToken,leaseExpiresAt:grant.leaseExpiresAt,trustedCheckPolicyDigest:grant.trustedCheckPolicyDigest,planDigest,executionLimits:{reservedBudgetCents:grant.slice.budgetCents,maxProviderCalls:config.workerMaxProviderCalls!,maxInputTokens:config.workerMaxInputTokens!,maxOutputTokens:config.workerMaxOutputTokens!,maxWallSeconds:config.workerMaxWallSeconds!,allowedProviders:config.workerAllowedProviders!,allowedModels:config.workerAllowedModels!}});return send(res,200,JSON.stringify(envelope));}
        const m=req.url?.match(/^\/api\/worker\/missions\/([^/]+)\/slices\/([^/]+)\/(heartbeat|result|outcome|progress)$/);if(m){const epoch=Number(req.headers["x-orloom-lease-epoch"]),auth=req.headers.authorization,cap=typeof auth==="string"?auth.replace(/^Bearer\s+/i,""):"",leaseToken=req.headers["x-orloom-lease-token"];if(!cap||typeof leaseToken!=="string"||!leaseToken)return send(res,401,JSON.stringify({error:"Unauthorized"}));if(!Number.isSafeInteger(epoch)||epoch<1)return send(res,400,JSON.stringify({error:"Invalid lease identity"}));const raw=parseJson(await body(req));const missionId=decodeURIComponent(m[1]!),id=decodeURIComponent(m[2]!);if(m[3]==="heartbeat"){const grant=await missionStore.heartbeat(missionId,id,epoch,leaseToken,cap,300);return send(res,200,JSON.stringify(grant));}if(m[3]==="progress"){if(!raw||typeof raw!=="object"||Array.isArray(raw))return send(res,400,JSON.stringify({error:"Invalid progress event"}));const p=raw as Record<string,unknown>;if(p.missionId!==missionId||p.sliceId!==id||p.leaseEpoch!==epoch)return send(res,409,JSON.stringify({error:"Progress lease identity mismatch"}));return send(res,200,JSON.stringify(await governor.recordProgress(p as unknown as RecoveryProgress,leaseToken,cap)));}if(m[3]==="outcome"){if(!raw||typeof raw!=="object"||!("outcome"in raw)||!(raw.outcome==="BLOCKED"||raw.outcome==="UNKNOWN")||!("reasonCode"in raw)||typeof raw.reasonCode!=="string"||!("evidenceRefs"in raw)||!Array.isArray(raw.evidenceRefs))return send(res,400,JSON.stringify({error:"Invalid worker outcome"}));return send(res,200,JSON.stringify(await governor.reportOutcome(missionId,id,epoch,leaseToken,cap,raw.outcome,raw.reasonCode,raw.evidenceRefs as string[])));}if(!raw||typeof raw!=="object"||!("candidateSha"in raw)||typeof raw.candidateSha!=="string"||!("evidenceRefs"in raw)||!Array.isArray(raw.evidenceRefs))return send(res,400,JSON.stringify({error:"Invalid candidate result"}));return send(res,200,JSON.stringify(await governor.complete(missionId,id,epoch,leaseToken,cap,raw.candidateSha,raw.evidenceRefs as string[])));}
      }
      if (req.method === "GET" && req.url?.startsWith("/api/jobs/")) {
        if (!validSession(req, config, sessions)) return send(res, 401, JSON.stringify({ error: "Unauthorized" }));
        const job = await jobs.get(decodeURIComponent(req.url.slice("/api/jobs/".length)));
        return job ? send(res, 200, JSON.stringify(job)) : send(res, 404, JSON.stringify({ error: "Not found" }));
      }
      return send(res, 404, JSON.stringify({ error: "Not found" }));
    } catch (error) {
      if (error instanceof RequestTooLargeError) return send(res, 413, JSON.stringify({ error: "Request too large" }));
      if (error instanceof InputValidationError) return send(res, 400, JSON.stringify({ error: "Invalid job input" }));
      if (error instanceof MissionValidationError) return send(res,400,JSON.stringify({error:"Invalid mission or plan input"}));
      if (error instanceof MissionConflictError) return send(res,409,JSON.stringify({error:"Mission state conflict"}));
      return send(res, 500, JSON.stringify({ error: "Internal server error" }));
    }
  });
}

function validSession(req: IncomingMessage, config: Config, sessions: Map<string, number>) {
  const value = decodeURIComponent(cookie(req, "orloom_session") ?? "");
  if (config.mode === "local") return Boolean(config.sessionToken && safeEqual(value, config.sessionToken));
  const expiry = sessions.get(value);
  if (!expiry || expiry <= Date.now()) { sessions.delete(value); return false; }
  return true;
}

function validWriteOrigin(req: IncomingMessage, config: Config) {
  const origin = req.headers.origin;
  const rawHosts: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]!.toLowerCase() === "host") rawHosts.push(req.rawHeaders[i + 1]!);
  if (!origin || rawHosts.length !== 1 || !config.publicOrigin || !config.host) return false;
  const host = rawHosts[0]!;
  const validHostname = (value: string) => value.length <= 253 && value.split(".").every(label => label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
  return origin === config.publicOrigin && validHostname(host) && validHostname(config.host) && host.toLowerCase() === config.host;
}
