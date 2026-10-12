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
  createInstallationToken(installationId: number, repositories: string[]): Promise<string>;
  createCheckRun(installationId: number, repository: string, headSha: string, name: string, conclusion: "success" | "failure"): Promise<void>;
}

export interface GitHubRequestClient {
  request(route: string, parameters: Record<string, unknown>): Promise<{ data: { token?: string } }>;
}
export interface GitHubRequestBoundary {
  app: GitHubRequestClient;
  installation(id: number): Promise<GitHubRequestClient>;
}

export function createGitHubAppAdapter(config: { appId: number; privateKey: string }, boundary?: GitHubRequestBoundary): GitHubInstallationClient {
  const app = boundary ? undefined : new App({ appId: config.appId, privateKey: config.privateKey });
  const appRequests: GitHubRequestClient = boundary?.app ?? {
    request: async (route, parameters) => app!.octokit.request(route as never, parameters as never)
  };
  const getInstallation = boundary?.installation ?? (async id => ({
    request: async (route: string, parameters: Record<string, unknown>) => (await app!.getInstallationOctokit(id)).request(route as never, parameters as never)
  }));
  return {
    async createInstallationToken(installationId, repositories) {
      if (!Number.isSafeInteger(installationId) || installationId < 1 || repositories.length === 0 || repositories.some(name => !/^[A-Za-z0-9_.-]+$/.test(name))) throw new Error("Installation and repository scope are required");
      const created = await appRequests.request("POST /app/installations/{installation_id}/access_tokens", {
        installation_id: installationId,
        repositories,
        permissions: { contents: "read", checks: "write" }
      });
      if (!created.data.token) throw new Error("GitHub did not return an installation token");
      return created.data.token;
    },
    async createCheckRun(installationId, repository, headSha, name, conclusion) {
      const [owner, repo] = repository.split("/");
      if (!owner || !repo || !/^[a-f0-9]{40}$/i.test(headSha)) throw new Error("Repository and full commit SHA are required");
      if (!Number.isSafeInteger(installationId) || installationId < 1) throw new Error("Installation scope is required");
      const installation = await getInstallation(installationId);
      await installation.request("POST /repos/{owner}/{repo}/check-runs", { owner, repo, head_sha: headSha, name, status: "completed", conclusion });
    }
  };
}

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
