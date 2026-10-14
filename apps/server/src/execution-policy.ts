import type { Agent, Run } from "../../../packages/shared/types";

export type ExecutionPermission = "read-only" | "workspace-write";
export function executionPermission(run: Pick<Run, "permission" | "preWriteApproval">): ExecutionPermission {
  const permission = run.permission ?? (run.preWriteApproval ? "workspace-write" : "read-only");
  if (permission !== "read-only" && permission !== "workspace-write") throw new Error("Unsupported execution permission; elevated actions require a separate authorization mechanism");
  if (permission === "workspace-write" && !run.preWriteApproval) throw new Error("Workspace writes require pre-write review");
  if (permission === "read-only" && run.preWriteApproval) throw new Error("Read-only runs cannot create a writable staging area");
  return permission;
}

// Templates cannot override the policy. Only model and reasoning selections
// are retained; arbitrary commands/config overrides fail closed.
export function secureAgentArgs(agent: Agent, permission: ExecutionPermission): string[] {
  if (!["codex", "claude", "gemini"].includes(agent.command)) throw new Error(`No restricted execution adapter for ${agent.command}`);
  const selections: string[] = [];
  const allowedBare = new Set(["exec", "-p", "--print", "{prompt}", "--json", "--ephemeral", "-"]);
  for (let i = 0; i < agent.argsTemplate.length; i++) {
    const arg = agent.argsTemplate[i];
    if (["--model", "-m", "--effort"].includes(arg)) {
      const value = agent.argsTemplate[++i];
      if (!value || !/^[a-zA-Z0-9._:/-]+$/.test(value) || value.startsWith("-")) throw new Error("Invalid model/effort selection");
      selections.push(arg, value);
    } else if (arg === "-c" && /^model_reasoning_effort="?(low|medium|high|xhigh|minimal|none)"?$/.test(agent.argsTemplate[i + 1] ?? "")) {
      selections.push(arg, agent.argsTemplate[++i]);
    } else if (!allowedBare.has(arg)) throw new Error(`Agent argument disallowed by execution policy: ${arg}`);
  }
  if (agent.command === "codex") return ["exec", "--ignore-user-config", "--ephemeral", "--json", "--sandbox", permission, "-c", 'approval_policy="never"', "-c", "sandbox_workspace_write.network_access=false", ...selections, "-"];
  if (agent.command === "claude") {
    if (permission !== "read-only") throw new Error("Claude workspace writes require the approval-capable adapter in PR-002");
    return ["-p", "--permission-mode", "dontAsk", "--tools", "Read,Glob,Grep", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence", ...selections];
  }
  throw new Error("Gemini execution requires capability and approval probes in PR-002; Antigravity is a separate provider");
}
