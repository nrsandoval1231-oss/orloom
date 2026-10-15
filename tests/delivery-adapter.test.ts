import { test } from "node:test";
import assert from "node:assert/strict";
import { createGitHubAppAdapter, type GitHubRequestBoundary } from "../packages/adapters/src/providers.js";

for (const effect of ["upload-token", "check", "pull-request"] as const) {
  test(`already-stopped ${effect} adapter does not mint credentials or dispatch`, async () => {
    let minted=0,dispatched=0;
    const client=createGitHubAppAdapter({appId:1,privateKey:"synthetic-only"},{app:{request:async()=>{minted++;return{data:{token:"synthetic-token"}};}},installation:async()=>({request:async()=>{dispatched++;throw new Error("unexpected dispatch");}})});
    const guard=async()=>{throw new Error("fixture lifecycle stopped");};
    if(effect==="upload-token")await assert.rejects(client.withContentsWriteToken!(7,"acme/orloom",async()=>{dispatched++;},guard),/fixture lifecycle stopped/);
    else if(effect==="check")await assert.rejects(client.createDeliveryCheck(7,"acme/orloom","a".repeat(40),"check","external","title","summary",guard),/fixture lifecycle stopped/);
    else await assert.rejects(client.createDraftPullRequest(7,"acme/orloom","orloom/delivery/fixture","main","title","body",guard),/fixture lifecycle stopped/);
    assert.equal(minted,0,"known stop is checked before scoped token issuance");
    assert.equal(dispatched,0);
  });
}

test("GitHub delivery adapter scopes short-lived installation tokens and reads exact branch, Check, and draft PR identities",async()=>{
  const mintCalls:Record<string,unknown>[]=[],installationTokens:string[]=[],calls:Array<{route:string;parameters:Record<string,unknown>}>=[];
  const head="a".repeat(40),tree="b".repeat(40),base="c".repeat(40),baseTree="d".repeat(40),externalId="mission:slice:1:"+head;
  const boundary:GitHubRequestBoundary={app:{request:async(_route,parameters)=>{mintCalls.push(parameters);return{data:{token:`token-${mintCalls.length}`}};}},installation:async(_id,token)=>{installationTokens.push(token??"");return{request:async(route,parameters)=>{calls.push({route,parameters});if(route==="GET /repos/{owner}/{repo}")return{data:{full_name:"acme/orloom"}};if(route.startsWith("GET /repos")&&route.includes("/git/ref/")){const ref=String(parameters.ref);return{data:{object:{sha:ref.endsWith("main")?base:head}}};}if(route.startsWith("GET /repos")&&route.includes("/git/commits/")){const commit=String(parameters.commit_sha);return{data:{sha:commit,tree:{sha:commit===base?baseTree:tree}}};}if(route.includes("/check-runs/{check_run_id}"))return{data:{id:81,head_sha:head,name:"Orloom suite",external_id:externalId,conclusion:"success",app:{id:1}}};if(route.startsWith("GET /repos")&&route.includes("/check-runs"))return{data:{check_runs:[]}};if(route.startsWith("POST /repos")&&route.includes("/check-runs"))return{data:{id:81,head_sha:head,name:"Orloom suite",external_id:externalId,conclusion:"success",app:{id:1}}};if(route==="GET /repos/{owner}/{repo}/pulls")return{data:[]};if(route==="POST /repos/{owner}/{repo}/pulls")return{data:{number:9,draft:true,state:"open",merged:false,head:{repo:{full_name:"acme/orloom"},ref:"orloom/delivery/x",sha:head},base:{repo:{full_name:"acme/orloom"},ref:"main",sha:base}}};if(route.includes("/pulls/{pull_number}"))return{data:{number:9,draft:true,head:{repo:{full_name:"acme/orloom"},ref:"orloom/delivery/x",sha:head},base:{repo:{full_name:"acme/orloom"},ref:"main",sha:base}}};throw new Error(`unexpected route ${route}`);}};}};
  const client=createGitHubAppAdapter({appId:1,privateKey:"test-only"},boundary);
  assert.equal(client.appId,1);assert.deepEqual(await client.inspectBranch(7,"acme/orloom","orloom/delivery/x"),{sha:head,treeSha:tree});
  const scoped=await client.withContentsWriteToken!(7,"acme/orloom",async token=>token);assert.equal(scoped,"token-2");
  const check=await client.createDeliveryCheck(7,"acme/orloom",head,"Orloom suite",externalId,"Title","Summary");assert.equal(check.id,81);assert.equal(check.conclusion,"success");assert.equal(check.appId,1);assert.equal((await client.getCheckRun(7,"acme/orloom",81)).appId,1);
  assert.deepEqual(await client.listCheckRuns(7,"acme/orloom",head,"Orloom suite",externalId),[]);
  assert.equal((await client.listPullRequests(7,"acme/orloom","orloom/delivery/x","main")).length,0);
  const pr=await client.createDraftPullRequest(7,"acme/orloom","orloom/delivery/x","main","Title","Body");assert.equal(pr.number,9);assert(pr.draft);assert.equal((await client.getPullRequest(7,"acme/orloom",9)).headSha,head);
  assert.equal(mintCalls.length,8);for(const p of mintCalls){assert.equal(p.installation_id,7);assert.deepEqual(p.repositories,["orloom"]);}assert.deepEqual(mintCalls.map(x=>x.permissions),[{contents:"read"},{contents:"write"},{checks:"write"},{checks:"read"},{checks:"read"},{pull_requests:"read"},{pull_requests:"write"},{pull_requests:"read"}]);
  assert(installationTokens.every(x=>x.startsWith("token-")));assert(calls.some(x=>x.route.startsWith("POST")&&x.route.includes("check-runs")&&(x.parameters as {external_id?:string}).external_id===externalId));assert(calls.some(x=>x.route==="POST /repos/{owner}/{repo}/pulls"&&(x.parameters as {draft?:boolean}).draft===true));
});

test("branch absence is distinct from inaccessible or wrong repository readback",async()=>{
  const make=(repositoryResponse:()=>Promise<{data:unknown}>,refResponse:()=>Promise<{data:unknown}>)=>createGitHubAppAdapter({appId:1,privateKey:"test-only"},{app:{request:async()=>({data:{token:"scoped"}})},installation:async()=>({request:async route=>route==="GET /repos/{owner}/{repo}"?repositoryResponse():refResponse()})});
  const notFound=Object.assign(new Error("not found"),{status:404});
  const absent=make(async()=>({data:{full_name:"acme/orloom"}}),async()=>{throw notFound;});
  assert.equal(await absent.inspectBranch(7,"acme/orloom","orloom/delivery/test"),null);
  const denied=make(async()=>{throw notFound;},async()=>({data:{object:{sha:"a".repeat(40)}}}));
  await assert.rejects(denied.inspectBranch(99,"acme/orloom","orloom/delivery/test"),/repository could not be verified/);
  const wrong=make(async()=>({data:{full_name:"other/repo"}}),async()=>({data:{object:{sha:"a".repeat(40)}}}));
  await assert.rejects(wrong.inspectBranch(7,"acme/orloom","orloom/delivery/test"),/repository could not be verified/);
});

test("lifecycle fence runs after Check and PR installation tokens are acquired but before POST",async()=>{
  const head="a".repeat(40),events:string[]=[];
  const boundary:GitHubRequestBoundary={
    app:{request:async()=>{events.push("token");return{data:{token:"scoped-token"}};}},
    installation:async(_id,token)=>{assert.equal(token,"scoped-token");events.push("installation");return{request:async(route)=>{events.push(route);if(route.startsWith("POST"))throw new Error("POST must not be reached");return{data:{}};}};}
  };
  const client=createGitHubAppAdapter({appId:1,privateKey:"test-only"},boundary);
  const ended=new Error("lifecycle ended");
  const guard=async()=>{events.push("guard");if(events.includes("installation"))throw ended;};
  await assert.rejects(client.createDeliveryCheck(7,"acme/orloom",head,"Orloom suite","external","Title","Summary",guard),error=>error===ended);
  assert.deepEqual(events,["guard","token","installation","guard"],"Check guard runs with the scoped client ready, directly before dispatch");
  events.length=0;
  await assert.rejects(client.createDraftPullRequest(7,"acme/orloom","branch","main","Title","Body",guard),error=>error===ended);
  assert.deepEqual(events,["guard","token","installation","guard"],"PR guard runs with the scoped client ready, directly before dispatch");
});
