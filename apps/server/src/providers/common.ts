import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ProviderCapabilities, ProviderId, ProviderProbe, NormalizedAgentConfiguration, ProviderErrorKind, ProviderEvent, ProviderEventPayload, ProviderResult, ProviderApprovalRequest } from "../../../../packages/shared/providers";
import { canonicalPath } from "../security";

export interface ProviderRunRequest {
  configuration: NormalizedAgentConfiguration;
  cwd: string;
  prompt: string;
  sessionId?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent: (event: ProviderEvent) => void;
  approve?: (request: ProviderApprovalRequest, signal: AbortSignal) => Promise<"approve" | "deny">;
}
export interface ProviderAdapter {
  readonly id: ProviderId;
  probe(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ProviderProbe>;
  run(request: ProviderRunRequest): Promise<ProviderResult>;
}
export class ProviderFailure extends Error {
  constructor(public kind: ProviderErrorKind, message: string, public retryable = false) { super(message); this.name = "ProviderFailure"; }
}
export function classifyError(message: string): ProviderFailure {
  if (/canceled|cancelled/i.test(message)) return new ProviderFailure("canceled", message);
  if (/UNSUPPORTED_CLIENT|client is no longer supported/i.test(message)) return new ProviderFailure("unavailable", "Google rejected this Gemini CLI client for the account's Code Assist tier (UNSUPPORTED_CLIENT). No API billing fallback was used.");
  if (/hit (?:your |the )?limit|usage.?limit/i.test(message)) return new ProviderFailure("quota", message);
  if (/not logged in|not authenticated|login required|authentication|auth.*required|oauth|API.?KEY|401\b/i.test(message)) return new ProviderFailure("authentication", message);
  if (/quota|billing|exhausted|out of credits|insufficient_quota/i.test(message)) return new ProviderFailure("quota", message);
  if (/429\b|rate.?limit|too many requests|overloaded/i.test(message)) return new ProviderFailure("rate_limit", message, true);
  if (/permission|approval|denied|forbidden|sandbox/i.test(message)) return new ProviderFailure("permission", message);
  if (/timed out|timeout/i.test(message)) return new ProviderFailure("timeout", message);
  return new ProviderFailure("execution", message);
}
export function probeScope(options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 30_000), ...(options.signal ? [options.signal] : [])]);
  return { signal, failure: (error: unknown) => options.signal?.aborted ? new ProviderFailure("canceled", "Provider probe canceled") : signal.aborted ? new ProviderFailure("timeout", "Provider probe timed out") : error instanceof ProviderFailure ? error : classifyError((error as Error).message) };
}
export function eventEmitter(provider: ProviderId, sink: ProviderRunRequest["onEvent"]) {
  let sequence = 0;
  return (payload: ProviderEventPayload) => sink({ ...payload, provider, sequence: ++sequence, timestamp: new Date().toISOString() });
}
export function unavailableCapabilities(): ProviderCapabilities {
  return { streaming: false, sessions: false, resumption: false, modelSelection: false, efforts: [], modelCatalog: "unavailable", permissions: [], approvals: "deny-only", nativeSubagents: { available: false, visibility: "none", configurableLimit: false }, skills: false };
}
export function normalizeConfiguration(input: NormalizedAgentConfiguration, probe: ProviderProbe): NormalizedAgentConfiguration {
  if (input.provider !== probe.provider || !["codex", "claude", "gemini", "antigravity"].includes(input.provider)) throw new ProviderFailure("configuration", "Unknown or mismatched provider");
  if (probe.error) throw new ProviderFailure(probe.error.kind, probe.error.message);
  if (!probe.installed) throw new ProviderFailure("unavailable", `${probe.provider} is not installed`);
  if (probe.authentication === "unauthenticated") throw new ProviderFailure("authentication", `${probe.provider} login required`);
  if (probe.authenticationMethod === "api") throw new ProviderFailure("configuration", "Managed CLI runs require account login. Configure an explicit API provider to use API billing.");
  if (!probe.capabilities.streaming) throw new ProviderFailure("unavailable", "Installed provider lacks the required structured interface");
  if (!probe.capabilities.permissions.includes(input.permission)) throw new ProviderFailure("configuration", `${probe.provider} does not support ${input.permission} through this adapter`);
  if (typeof input.role !== "string" || !input.role.trim() || !Array.isArray(input.skills) || input.skills.length) throw new ProviderFailure("configuration", "Role is required; managed skills are unavailable until run-scoped integration is implemented");
  if (!input.subagents || input.subagents.enabled || input.subagents.maxConcurrent !== 0) throw new ProviderFailure("configuration", "Managed subagent controls are unavailable in this adapter release");
  if (input.model && (!probe.capabilities.modelSelection || !/^[a-zA-Z0-9._:/-]{1,200}$/.test(input.model) || input.model.startsWith("-"))) throw new ProviderFailure("configuration", "Unsupported model selection");
  const model = input.model && probe.models.find((m) => m.id === input.model);
  if (input.model && probe.capabilities.modelCatalog === "provider" && !model) throw new ProviderFailure("configuration", "Model is absent from the current provider catalog");
  if (input.effort && !(model ? model.efforts : probe.capabilities.efforts).includes(input.effort)) throw new ProviderFailure("configuration", "Unsupported reasoning effort");
  if (input.fallback && !["codex", "claude", "gemini", "antigravity"].includes(input.fallback.provider)) throw new ProviderFailure("configuration", "Invalid fallback provider");
  return { ...input, skills: [], subagents: { enabled: false, maxConcurrent: 0 }, fallback: input.fallback && { ...input.fallback } };
}
export function validateRun(request: ProviderRunRequest): string {
  if (typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > 500_000) throw new ProviderFailure("configuration", "Invalid provider prompt");
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 3_600_000) throw new ProviderFailure("configuration", "Invalid provider timeout");
  if (request.signal?.aborted) throw new ProviderFailure("canceled", "Canceled before execution");
  const cwd = resolve(request.cwd);
  if (!existsSync(cwd)) throw new ProviderFailure("configuration", "Approved workspace does not exist");
  return canonicalPath(cwd);
}
