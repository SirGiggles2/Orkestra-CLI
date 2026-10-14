export type ProviderId = "codex" | "claude" | "gemini" | "antigravity";
export type ProviderPermission = "read-only" | "workspace-write";
export type ProviderErrorKind = "authentication" | "quota" | "rate_limit" | "permission" | "tool" | "timeout" | "canceled" | "interrupted" | "unavailable" | "configuration" | "protocol" | "execution";
export interface ProviderModel {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort?: string;
  isDefault?: boolean;
  accessVerified: boolean;
}
export interface ProviderCapabilities {
  streaming: boolean;
  sessions: boolean;
  resumption: boolean;
  modelSelection: boolean;
  efforts: string[];
  modelCatalog: "provider" | "unavailable";
  permissions: ProviderPermission[];
  approvals: "request-response" | "deny-only";
  nativeSubagents: { available: boolean; visibility: "none" | "events"; configurableLimit: boolean };
  skills: boolean;
}
export interface ProviderProbe {
  provider: ProviderId;
  installed: boolean;
  version?: string;
  authentication: "authenticated" | "unauthenticated" | "unknown";
  authenticationSource: "provider" | "unavailable";
  authenticationMethod?: "account" | "api" | "unknown";
  capabilities: ProviderCapabilities;
  models: ProviderModel[];
  checkedAt: string;
  error?: { kind: ProviderErrorKind; message: string };
}
export interface NormalizedAgentConfiguration {
  provider: ProviderId;
  model?: string;
  effort?: string;
  role: string;
  skills: string[];
  permission: ProviderPermission;
  subagents: { enabled: boolean; maxConcurrent: number };
  fallback?: { provider: ProviderId; model?: string; effort?: string };
}
export interface EffectiveAgentConfiguration extends NormalizedAgentConfiguration {
  modelConfirmed: boolean;
  effortConfirmed: boolean;
  sessionId?: string;
  cwd: string;
  transport: "app-server" | "stream-json";
}
export interface ProviderApprovalRequest {
  id: string;
  provider: ProviderId;
  kind: "command" | "file-change";
  sessionId: string;
  turnId: string;
  description: string;
  cwd?: string;
}
export type ProviderEventPayload =
  | { type: "configuration"; configuration: EffectiveAgentConfiguration }
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; status: "started" | "completed" | "failed"; detail?: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number; totalTokens?: number }
  | { type: "approval_requested"; request: ProviderApprovalRequest }
  | { type: "approval_resolved"; id: string; decision: "approve" | "deny" }
  | { type: "diagnostic"; message: string }
  | { type: "error"; kind: ProviderErrorKind; message: string; retryable: boolean }
  | { type: "completed"; sessionId: string; output: string }
  | { type: "canceled"; reason: string };
export type ProviderEvent = ProviderEventPayload & { provider: ProviderId; sequence: number; timestamp: string };
export interface ProviderResult {
  provider: ProviderId;
  sessionId: string;
  output: string;
  configuration: EffectiveAgentConfiguration;
  usage?: Extract<ProviderEventPayload, { type: "usage" }>;
}
