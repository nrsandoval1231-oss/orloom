import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Config } from "../../../packages/config/src/config.js";
import { InputValidationError, JobStore } from "../../../packages/contracts/src/job.js";

class RequestTooLargeError extends Error {}

function page(configured: boolean) { return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Orloom</title><main><h1>Orloom</h1><p id="state">Local control plane. Live execution is disabled. ${configured ? "Session configured." : "Unconfigured: set ORLOOM_SESSION_TOKEN to enable submissions."}</p><form id="login"><label>Session token <input type="password" autocomplete="current-password" required></label><button ${configured ? "" : "disabled"}>Unlock local submissions</button></form><form id="job"><label>Repository <input name="repository" placeholder="owner/repo" required></label><label>Task <textarea name="task" required></textarea></label><button ${configured ? "" : "disabled"}>Queue job</button></form><pre id="result"></pre></main><script>
const state=document.querySelector('#state'), result=document.querySelector('#result');
document.querySelector('#login').onsubmit=async e=>{e.preventDefault();const token=e.target.querySelector('input').value;const r=await fetch('/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});state.textContent=r.ok?'Session unlocked.':'Could not unlock session.';e.target.reset()};
document.querySelector('#job').onsubmit=async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));const r=await fetch('/api/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});result.textContent=r.ok?JSON.stringify(await r.json(),null,2):'Submission failed: '+r.status};
</script></html>`; }

function safeEqual(a: string, b: string) { const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
function cookie(req: IncomingMessage, key: string) { return req.headers.cookie?.split(";").map(x => x.trim()).find(x => x.startsWith(`${key}=`))?.slice(key.length + 1); }
async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 256_000) throw new RequestTooLargeError(); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
function send(res: ServerResponse, status: number, data: string, type = "application/json") { res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "x-content-type-options": "nosniff", "cache-control": "no-store" }); res.end(data); }

export function createControlPlane(config: Config, jobs: JobStore) {
  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") return send(res, 200, page(Boolean(config.sessionToken)), "text/html");
      if (req.method === "GET" && req.url === "/health") return send(res, 200, JSON.stringify({ status: "ok", mode: config.mode, liveExecution: false }));
      if (req.method === "POST" && req.url === "/session") {
        const raw = await body(req);
        let input: unknown;
        try { input = JSON.parse(raw.toString()); } catch { return send(res, 400, JSON.stringify({ error: "Invalid JSON" })); }
        const token = typeof input === "object" && input && "token" in input && typeof input.token === "string" ? input.token : "";
        if (!config.sessionToken || !safeEqual(token, config.sessionToken)) return send(res, 401, JSON.stringify({ error: "Unauthorized" }));
        res.writeHead(204, { "set-cookie": `orloom_session=${encodeURIComponent(config.sessionToken)}; HttpOnly; SameSite=Strict; Path=/`, "cache-control": "no-store" });
        return res.end();
      }
      if (req.method === "POST" && req.url === "/api/jobs") {
        const session = decodeURIComponent(cookie(req, "orloom_session") ?? "");
        if (!config.sessionToken || !safeEqual(session, config.sessionToken)) return send(res, 401, JSON.stringify({ error: "Unauthorized" }));
        const raw = await body(req);
        let input: unknown;
        try { input = JSON.parse(raw.toString()); } catch { return send(res, 400, JSON.stringify({ error: "Invalid JSON" })); }
        if (typeof input !== "object" || !input || !("repository" in input) || !("task" in input) || typeof input.repository !== "string" || typeof input.task !== "string") return send(res, 400, JSON.stringify({ error: "repository and task are required" }));
        const job = await jobs.submit({ repository: input.repository, task: input.task });
        return send(res, 201, JSON.stringify(job));
      }
      if (req.method === "GET" && req.url?.startsWith("/api/jobs/")) {
        const session = decodeURIComponent(cookie(req, "orloom_session") ?? "");
        if (!config.sessionToken || !safeEqual(session, config.sessionToken)) return send(res, 401, JSON.stringify({ error: "Unauthorized" }));
        const job = await jobs.get(decodeURIComponent(req.url.slice("/api/jobs/".length)));
        return job ? send(res, 200, JSON.stringify(job)) : send(res, 404, JSON.stringify({ error: "Not found" }));
      }
      return send(res, 404, JSON.stringify({ error: "Not found" }));
    } catch (error) {
      if (error instanceof RequestTooLargeError) return send(res, 413, JSON.stringify({ error: "Request too large" }));
      if (error instanceof InputValidationError) return send(res, 400, JSON.stringify({ error: "Invalid job input" }));
      return send(res, 500, JSON.stringify({ error: "Internal server error" }));
    }
  });
}
