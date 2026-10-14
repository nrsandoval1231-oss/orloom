import { CandidateArtifactInvalidError } from "../../contracts/src/verification.js";
import { createHash } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { BoundedCandidateArtifacts } from "../../verification/src/candidate-admission.js";
export interface CandidateObjectClient {send(command:GetObjectCommand,options:{abortSignal:AbortSignal}):Promise<unknown>;}
type Body=AsyncIterable<Uint8Array>&{destroy(error?:Error):void};
/** Uses existing operator-provided R2 credentials; never creates or stores any.
 * Untrusted bytes are streamed under a caller-visible abort signal and hard cap. */
export function createR2CandidateArtifacts(config:{accountId:string;accessKeyId:string;secretAccessKey:string;bucket:string},boundary?:CandidateObjectClient):BoundedCandidateArtifacts {
  const client=boundary?undefined:new S3Client({region:"auto",endpoint:`https://${config.accountId}.r2.cloudflarestorage.com`,maxAttempts:1,credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey}});
  const requests:CandidateObjectClient=boundary??{send:(command,options)=>client!.send(command,options)};
  return {async getBounded(key,maxBytes,callerSignal){
    if(!/^sha256\/[a-f0-9]{64}$/.test(key)||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>20_000_000)throw new CandidateArtifactInvalidError("Candidate artifact key or byte bound is invalid");
    const signal=AbortSignal.any([callerSignal,AbortSignal.timeout(10_000)]);signal.throwIfAborted();
    const response=await requests.send(new GetObjectCommand({Bucket:config.bucket,Key:key,Range:`bytes=0-${maxBytes}`}),{abortSignal:signal}) as {Body?:Body;ContentLength?:number};
    const body=response.Body;
    if(!body||typeof body[Symbol.asyncIterator]!=="function"||typeof body.destroy!=="function")throw new Error("Candidate artifact body is not a cancellable stream");
    const abort=()=>body.destroy(new Error("Candidate artifact stream aborted"));signal.addEventListener("abort",abort,{once:true});
    try {
      signal.throwIfAborted();
      if(response.ContentLength!==undefined&&(!Number.isSafeInteger(response.ContentLength)||response.ContentLength<0||response.ContentLength>maxBytes))throw new CandidateArtifactInvalidError("Candidate artifact exceeds byte bound");
      const chunks:Buffer[]=[];let total=0,count=0;
      for await(const chunk of body){signal.throwIfAborted();if(!(chunk instanceof Uint8Array))throw new CandidateArtifactInvalidError("Candidate artifact stream returned invalid bytes");total+=chunk.length;count++;if(total>maxBytes||count>65_536)throw new CandidateArtifactInvalidError("Candidate artifact exceeds stream bound");chunks.push(Buffer.from(chunk));}
      signal.throwIfAborted();const bytes=Buffer.concat(chunks);
      if(createHash("sha256").update(bytes).digest("hex")!==key.slice(7))throw new CandidateArtifactInvalidError("Candidate artifact digest mismatch");
      return bytes;
    }finally{signal.removeEventListener("abort",abort);body.destroy();}
  }};
}
