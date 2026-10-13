import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { App } from "@octokit/app";
import type { CodexOptions } from "@openai/codex-sdk";
import { validCodexHome } from "../../config/src/config.js";

export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^sha256=[0-9a-f]{64}$/i.test(signature) || !secret) return false;
  const supplied = Buffer.from(signature.slice(7), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export interface ArtifactStore {
  put(bytes: Uint8Array, contentType: string): Promise<{ key: string; sha256: string }>;
  get(key: string): Promise<Uint8Array>;
}

export interface R2RequestClient {
  send(command: PutObjectCommand | GetObjectCommand): Promise<unknown>;
}

export function createR2ArtifactStore(config: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }, requestClient?: R2RequestClient): ArtifactStore {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
  });
  const requests: R2RequestClient = requestClient ?? { send: command => client.send(command as never) };
  return {
    async put(bytes, contentType) {
      const hash = createHash("sha256").update(bytes).digest("hex");
      const key = `sha256/${hash}`;
      await requests.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: bytes, ContentType: contentType, Metadata: { sha256: hash }, IfNoneMatch: "*" }));
      return { key, sha256: hash };
    },
    async get(key) {
      if (!/^sha256\/[a-f0-9]{64}$/.test(key)) throw new Error("Invalid artifact key");
      const response = await requests.send(new GetObjectCommand({ Bucket: config.bucket, Key: key })) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
      if (!response.Body) throw new Error("Artifact has no body");
      const bytes = await response.Body.transformToByteArray();
      const expected = key.startsWith("sha256/") ? key.slice(7) : "";
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== expected) throw new Error("Artifact digest does not match its key");
      return bytes;
    }
  };
}

export class LocalArtifactStore implements ArtifactStore {
  private readonly values = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array, _contentType: string) {
    const copy = new Uint8Array(bytes);
    const hash = createHash("sha256").update(copy).digest("hex");
    const key = `sha256/${hash}`;
    this.values.set(key, copy);
    return { key, sha256: hash };
  }
  async get(key: string) {
    const value = this.values.get(key);
    if (!value) throw new Error("Artifact not found");
    return new Uint8Array(value);
  }
}

export interface GitHubInstallationClient {
  readonly appId: number;
  createInstallationToken(installationId: number, repositories: string[]): Promise<string>;
  createCheckRun(installationId: number, repository: string, headSha: string, name: string, conclusion: "success" | "failure"): Promise<void>;
  inspectBranch(installationId:number,repository:string,branch:string):Promise<{sha:string;treeSha:string}>;
  listCheckRuns(installationId:number,repository:string,headSha:string,name:string,externalId:string):Promise<Array<{id:number;headSha:string;name:string;externalId:string|null;conclusion:string|null;appId:number|null}>>;
  getCheckRun(installationId:number,repository:string,id:number):Promise<{id:number;headSha:string;name:string;externalId:string|null;conclusion:string|null;appId:number|null}>;
  createDeliveryCheck(installationId:number,repository:string,headSha:string,name:string,externalId:string,title:string,summary:string):Promise<{id:number;headSha:string;name:string;externalId:string|null;conclusion:string|null;appId:number|null}>;
  listPullRequests(installationId:number,repository:string,head:string,base:string):Promise<Array<{number:number;draft:boolean;state:string;merged:boolean;headRepository:string|null;headRef:string;headSha:string;baseRepository:string|null;baseRef:string;baseSha:string}>>;
  createDraftPullRequest(installationId:number,repository:string,head:string,base:string,title:string,body:string):Promise<{number:number;draft:boolean;state:string;merged:boolean;headRepository:string|null;headRef:string;headSha:string;baseRepository:string|null;baseRef:string;baseSha:string}>;
  getPullRequest(installationId:number,repository:string,number:number):Promise<{number:number;draft:boolean;state:string;merged:boolean;headRepository:string|null;headRef:string;headSha:string;baseRepository:string|null;baseRef:string;baseSha:string}>;
}

export interface GitHubRequestClient {
  request(route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }>;
}
export interface GitHubRequestBoundary {
  app: GitHubRequestClient;
  installation(id: number, token?:string): Promise<GitHubRequestClient>;
}

export function createGitHubAppAdapter(config: { appId: number; privateKey: string }, boundary?: GitHubRequestBoundary): GitHubInstallationClient {
  const app = boundary ? undefined : new App({ appId: config.appId, privateKey: config.privateKey });
  const appRequests: GitHubRequestClient = boundary?.app ?? {
    request: async (route, parameters) => app!.octokit.request(route as never, parameters as never)
  };
  const scopedInstallation = async (id:number,repository:string,permissions:Record<string,"read"|"write">) => {const [owner,name]=repository.split("/");if(!owner||!name||!Number.isSafeInteger(id)||id<1)throw new Error("Installation and repository scope are required");const minted=await appRequests.request("POST /app/installations/{installation_id}/access_tokens",{installation_id:id,repositories:[name],permissions});const token=(minted.data as Record<string,unknown>|null)?.token;if(typeof token!=="string"||!token)throw new Error("GitHub did not return a scoped installation token");if(boundary)return boundary.installation(id,token);const RuntimeOctokit=app!.octokit.constructor as new(options:{auth:string})=>GitHubRequestClient;const client=new RuntimeOctokit({auth:token});return{request:(route:string,parameters:Record<string,unknown>)=>client.request(route,parameters)};};
  const listPages=async(client:GitHubRequestClient,route:string,parameters:Record<string,unknown>,arrayField?:string)=>{const rows:Record<string,unknown>[]=[];for(let page=1;page<=10;page++){const value=(await client.request(route,{...parameters,page,per_page:100})).data;const pageRows=Array.isArray(value)?value:arrayField&&value&&typeof value==="object"?(value as Record<string,unknown>)[arrayField]:null;if(!Array.isArray(pageRows))throw new Error("GitHub list response is malformed");rows.push(...pageRows as Record<string,unknown>[]);if(pageRows.length<100)return rows;}throw new Error("GitHub result exceeds bounded delivery reconciliation limit");};
  return {
    appId: config.appId,
    async createInstallationToken(installationId, repositories) {
      if (!Number.isSafeInteger(installationId) || installationId < 1 || repositories.length === 0 || repositories.some(name => !/^[A-Za-z0-9_.-]+$/.test(name))) throw new Error("Installation and repository scope are required");
      const created = await appRequests.request("POST /app/installations/{installation_id}/access_tokens", {
        installation_id: installationId,
        repositories,
        permissions: { contents: "read", checks: "write" }
      });
      const token=(created.data as Record<string,unknown>|null)?.token;if(typeof token!=="string"||!token)throw new Error("GitHub did not return an installation token");
      return token;
    },
    async createCheckRun(installationId, repository, headSha, name, conclusion) {
      const [owner, repo] = repository.split("/");
      if (!owner || !repo || !/^[a-f0-9]{40}$/i.test(headSha)) throw new Error("Repository and full commit SHA are required");
      if (!Number.isSafeInteger(installationId) || installationId < 1) throw new Error("Installation scope is required");
      const installation = await scopedInstallation(installationId,repository,{contents:"read",checks:"write"});
      await installation.request("POST /repos/{owner}/{repo}/check-runs", { owner, repo, head_sha: headSha, name, status: "completed", conclusion });
    },
    async inspectBranch(installationId,repository,branch){
      const [owner,repo]=repository.split("/");if(!owner||!repo||!Number.isSafeInteger(installationId)||installationId<1||!branch||branch.startsWith("/")||branch.includes("..")||branch.includes("\\")||/[^A-Za-z0-9._/-]/.test(branch))throw new Error("Approved repository, installation and git ref are required");const client=await scopedInstallation(installationId,repository,{contents:"read"});
      const ref=(await client.request("GET /repos/{owner}/{repo}/git/ref/{ref}",{owner,repo,ref:`heads/${branch}`})).data as {object?:{sha?:string}};const sha=ref.object?.sha;if(typeof sha!=="string"||! /^[a-f0-9]{40}$/.test(sha))throw new Error("Remote branch readback is invalid");const commit=(await client.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}",{owner,repo,commit_sha:sha})).data as {sha?:string;tree?:{sha?:string}};if(commit.sha!==sha||typeof commit.tree?.sha!=="string"||! /^[a-f0-9]{40}$/.test(commit.tree.sha))throw new Error("Remote commit readback is invalid");return{sha,treeSha:commit.tree.sha};
    },
    async listCheckRuns(installationId,repository,headSha,name,externalId){const [owner,repo]=repository.split("/");if(!owner||!repo||! /^[a-f0-9]{40}$/.test(headSha))throw new Error("Repository and full commit SHA are required");const client=await scopedInstallation(installationId,repository,{checks:"read"});const data=await listPages(client,"GET /repos/{owner}/{repo}/commits/{ref}/check-runs",{owner,repo,ref:headSha},"check_runs");return data.filter(x=>x.name===name||x.external_id===externalId).map(checkRun);},
    async getCheckRun(installationId,repository,id){const [owner,repo]=repository.split("/");if(!owner||!repo||!Number.isSafeInteger(id)||id<1)throw new Error("Repository and Check identity are required");const client=await scopedInstallation(installationId,repository,{checks:"read"});return checkRun((await client.request("GET /repos/{owner}/{repo}/check-runs/{check_run_id}",{owner,repo,check_run_id:id})).data as Record<string,unknown>);},
    async createDeliveryCheck(installationId,repository,headSha,name,externalId,title,summary){const [owner,repo]=repository.split("/");if(!owner||!repo||! /^[a-f0-9]{40}$/.test(headSha))throw new Error("Repository and full commit SHA are required");const client=await scopedInstallation(installationId,repository,{checks:"write"});const data=(await client.request("POST /repos/{owner}/{repo}/check-runs",{owner,repo,head_sha:headSha,name,external_id:externalId,status:"completed",conclusion:"success",output:{title,summary}})).data as Record<string,unknown>;return checkRun(data);},
    async listPullRequests(installationId,repository,head,base){const [owner,repo]=repository.split("/");if(!owner||!repo)throw new Error("Repository is required");const client=await scopedInstallation(installationId,repository,{pull_requests:"read"});const data=await listPages(client,"GET /repos/{owner}/{repo}/pulls",{owner,repo,state:"all",head:`${owner}:${head}`,base});return data.map(pullRequest);},
    async createDraftPullRequest(installationId,repository,head,base,title,body){const [owner,repo]=repository.split("/");if(!owner||!repo)throw new Error("Repository is required");const client=await scopedInstallation(installationId,repository,{pull_requests:"write"});const x=(await client.request("POST /repos/{owner}/{repo}/pulls",{owner,repo,head,base,title,body,draft:true})).data as Record<string,unknown>;return pullRequest(x);},
    async getPullRequest(installationId,repository,number){const [owner,repo]=repository.split("/");if(!owner||!repo||!Number.isSafeInteger(number)||number<1)throw new Error("Repository and PR identity are required");const client=await scopedInstallation(installationId,repository,{pull_requests:"read"});const x=(await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}",{owner,repo,pull_number:number})).data as Record<string,unknown>;return pullRequest(x);}
  };
}

function checkRun(x:Record<string,unknown>){const app=x.app as Record<string,unknown>|null;return{id:Number(x.id),headSha:String(x.head_sha??""),name:String(x.name??""),externalId:typeof x.external_id==="string"?x.external_id:null,conclusion:typeof x.conclusion==="string"?x.conclusion:null,appId:Number.isSafeInteger(app?.id)?Number(app!.id):null};}
function pullRequest(x:Record<string,unknown>){const h=x.head as Record<string,unknown>,b=x.base as Record<string,unknown>,hr=h.repo as Record<string,unknown>|null,br=b.repo as Record<string,unknown>|null;return{number:Number(x.number),draft:x.draft===true,state:String(x.state??""),merged:x.merged===true,headRepository:typeof hr?.full_name==="string"?hr.full_name:null,headRef:String(h.ref??""),headSha:String(h.sha??""),baseRepository:typeof br?.full_name==="string"?br.full_name:null,baseRef:String(b.ref??""),baseSha:String(b.sha??"")};}

export interface CodexThread {
  run(input: string): Promise<unknown>;
}
export interface CodexClient {
  startThread(options: { workingDirectory: string }): CodexThread;
}

export interface CodexSdkConstructor {
  new(options: Omit<CodexOptions, "env" | "config"> & {
    env: Record<string, string>;
    config: NonNullable<CodexOptions["config"]> & { forced_login_method: "chatgpt" };
  }): CodexClient;
}

export function createCodexAdapter(Sdk: CodexSdkConstructor, workingDirectory: string, env: Record<string, string>) {
  const isolatedEnv = Object.freeze({ ...env });
  return {
    async run(input: string) {
      if (!validCodexHome(isolatedEnv.CODEX_HOME, isolatedEnv.ORLOOM_WORKER_JOB_DIRECTORY) || !validCodexHome(isolatedEnv.CODEX_HOME, workingDirectory)) throw new Error("Codex subscription requires an absolute CODEX_HOME outside the job workspace");
      if (isolatedEnv.CODEX_API_KEY || isolatedEnv.OPENAI_API_KEY) throw new Error("Codex subscription does not accept API key environment settings");
      const codex = new Sdk({ env: isolatedEnv, config: { forced_login_method: "chatgpt" } });
      const thread = codex.startThread({ workingDirectory });
      return thread.run(input);
    }
  };
}

export function unavailableLiveProvider(name: string): never {
  throw new Error(`${name} provider is not configured; live execution is disabled`);
}
