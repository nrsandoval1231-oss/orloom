import { Codex } from "@openai/codex-sdk";
import { createCodexAdapter } from "./providers.js";

export function createCodexSdkAdapter(workingDirectory: string, env: Record<string, string>) {
  return createCodexAdapter(Codex, workingDirectory, env);
}
