import type { ProviderId, NormalizedAgentConfiguration } from "../../../../packages/shared/providers";
import type { Agent } from "../../../../packages/shared/types";
import { CodexAdapter } from "./codex";
import { HeadlessAdapter } from "./headless";
import type { ProviderAdapter } from "./common";
import { ProviderFailure } from "./common";
import { secureAgentArgs } from "../execution-policy";

export const providerAdapters: Record<ProviderId, ProviderAdapter> = { codex: new CodexAdapter(), claude: new HeadlessAdapter("claude"), gemini: new HeadlessAdapter("gemini"), antigravity: new HeadlessAdapter("antigravity") };
export function configurationFromAgent(agent: Agent, permission: "read-only" | "workspace-write"): NormalizedAgentConfiguration {
  if (agent.command === "agy") agent = { ...agent, command: "antigravity" };
  if (!Object.hasOwn(providerAdapters, agent.command)) throw new ProviderFailure("configuration", "Unknown provider; Antigravity is separate from Gemini");
  // Reuse the existing denylist/selection parser for stored templates. Gemini
  // shares selection syntax but never inherits Codex execution flags.
  const args = secureAgentArgs({ ...agent, command: "codex" }, "read-only");
  let model: string | undefined, effort: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-m" || args[i] === "--model") model = args[++i];
    else if (args[i] === "--effort") effort = args[++i];
    else if (args[i] === "-c") { const value = args[++i].match(/^model_reasoning_effort="?([a-z]+)"?$/)?.[1]; if (value) effort = value; }
  }
  return { provider: agent.command as ProviderId, model, effort, role: agent.role, skills: [], permission, subagents: { enabled: false, maxConcurrent: 0 } };
}
