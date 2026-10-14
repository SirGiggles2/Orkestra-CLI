import { randomUUID } from "node:crypto";
import type { EffectiveAgentConfiguration, ProviderProbe, ProviderResult, ProviderEventPayload, ProviderApprovalRequest } from "../../../../packages/shared/providers";
import { pathWithin } from "../security";
import { runCommand } from "../process";
import { CodexRpc, type RpcFactory, type RpcMessage } from "./rpc";
import { classifyError, eventEmitter, normalizeConfiguration, probeScope, ProviderFailure, unavailableCapabilities, validateRun, type ProviderAdapter, type ProviderRunRequest } from "./common";

export class CodexAdapter implements ProviderAdapter {
  readonly id = "codex" as const;
  private sessions = new Map<string, { cwd: string; permission: string; nativeId: string }>();
  constructor(private factory?: RpcFactory, private command: typeof runCommand = runCommand) {}
  async probe(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ProviderProbe> {
    const probe: ProviderProbe = { provider: this.id, installed: false, authentication: "unknown", authenticationSource: "unavailable", capabilities: unavailableCapabilities(), models: [], checkedAt: new Date().toISOString() };
    let rpc: CodexRpc | undefined;
    const scope = probeScope(options), stop = () => { void rpc?.close().catch(() => {}); };
    scope.signal.addEventListener("abort", stop, { once: true });
    try {
      probe.version = await this.command("codex", ["--version"], "", 10_000, undefined, scope.signal);
      probe.installed = true;
      if (scope.signal.aborted) throw scope.failure(new Error("aborted"));
      rpc = new CodexRpc(undefined, this.factory); await rpc.initialize();
      const account = await rpc.request("account/read", { refreshToken: false });
      probe.authentication = account.account ? "authenticated" : "unauthenticated";
      probe.authenticationSource = "provider";
      probe.authenticationMethod = account.account?.type === "apiKey" ? "api" : account.account?.type === "chatgpt" ? "account" : "unknown";
      const models: ProviderProbe["models"] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = await rpc.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result.data)) throw new ProviderFailure("protocol", "Invalid Codex model catalog");
        for (const model of result.data) {
          if (typeof model.model !== "string" || !Array.isArray(model.supportedReasoningEfforts)) throw new ProviderFailure("protocol", "Invalid Codex model capability");
          models.push({ id: model.model, label: model.displayName || model.model, efforts: model.supportedReasoningEfforts.map((e: any) => e.reasoningEffort).filter((e: unknown) => typeof e === "string"), defaultEffort: model.defaultReasoningEffort, isDefault: model.isDefault === true, accessVerified: false });
        }
        if (!result.nextCursor) break;
        if (result.nextCursor === cursor || page === 19) throw new ProviderFailure("protocol", "Codex model catalog pagination did not terminate");
        cursor = result.nextCursor;
      }
      probe.models = models;
      probe.capabilities = { streaming: true, sessions: true, resumption: true, modelSelection: true, efforts: [...new Set(models.flatMap((m) => m.efforts))], modelCatalog: "provider", permissions: ["read-only", "workspace-write"], approvals: "request-response", nativeSubagents: { available: false, visibility: "events", configurableLimit: false }, skills: false };
    } catch (error) { const failure = scope.failure(error); probe.error = { kind: !probe.installed && !scope.signal.aborted ? "unavailable" : failure.kind, message: failure.message }; }
    finally { scope.signal.removeEventListener("abort", stop); if (rpc) await rpc.close(); }
    return probe;
  }
  async run(request: ProviderRunRequest): Promise<ProviderResult> {
    const cwd = validateRun(request);
    const started = Date.now();
    const config = normalizeConfiguration(request.configuration, await this.probe({ signal: request.signal, timeoutMs: request.timeoutMs }));
    validateRun(request);
    const emit = eventEmitter(this.id, request.onEvent);
    const owned = request.sessionId && this.sessions.get(request.sessionId);
    if (request.sessionId && (!owned || owned.cwd !== cwd || owned.permission !== config.permission)) throw new ProviderFailure("configuration", "Session does not belong to this managed workspace and permission scope");
    const rpc = new CodexRpc(cwd, this.factory);
    const controller = new AbortController();
    let nativeId = "", turnId = "", output = "", settled = false, abortKind: "timeout" | "canceled" | undefined;
    let usage: Extract<ProviderEventPayload, { type: "usage" }> | undefined;
    let effective: EffectiveAgentConfiguration;
    let complete!: (result: ProviderResult) => void, fail!: (error: Error) => void;
    const terminal = new Promise<ProviderResult>((resolve, reject) => { complete = resolve; fail = reject; });
    // Initialization errors are observed below even if no turn has been started.
    void terminal.catch(() => {});
    const stop = async (kind: "timeout" | "canceled") => {
      if (settled) return;
      abortKind = kind; controller.abort();
      if (nativeId && turnId) await rpc.request("turn/interrupt", { threadId: nativeId, turnId }, 2000).catch(() => {});
      await rpc.close().catch(() => {});
      if (!settled) { settled = true; fail(new ProviderFailure(kind, `Codex ${kind}`)); }
    };
    const onAbort = () => { void stop("canceled"); };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { void stop("timeout"); }, Math.max(1, request.timeoutMs - (Date.now() - started)));
    const sessionId = request.sessionId ?? randomUUID();
    const handleApproval = async (message: RpcMessage) => {
      const p = message.params;
      if (!p || p.threadId !== nativeId || typeof p.turnId !== "string") { rpc.rejectRequest(message.id!); return; }
      const kind = message.method === "item/commandExecution/requestApproval" ? "command" : "file-change";
      const approval: ProviderApprovalRequest = { id: String(message.id), provider: this.id, kind, sessionId, turnId: p.turnId, description: p.command || p.reason || "Provider requests approval", cwd: p.cwd };
      emit({ type: "approval_requested", request: approval });
      let decision: "approve" | "deny" = "deny";
      const scopeAllowed = (!p.cwd || pathWithin(cwd, p.cwd)) && !p.grantRoot && !p.networkApprovalContext && !p.environmentId && !(kind === "file-change" && config.permission === "read-only");
      if (scopeAllowed && request.approve && !controller.signal.aborted) {
        try { decision = await request.approve(approval, controller.signal); } catch { decision = "deny"; }
      }
      if (decision !== "approve" || controller.signal.aborted) decision = "deny";
      rpc.respond(message.id!, { decision: decision === "approve" ? "accept" : "decline" });
      emit({ type: "approval_resolved", id: approval.id, decision });
    };
    const unsubscribe = rpc.subscribe((message) => {
      if (message.id !== undefined && message.method) {
        if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(message.method)) void handleApproval(message).catch((error) => { if (!settled) { settled = true; fail(error); } });
        else rpc.rejectRequest(message.id);
        return;
      }
      const p = message.params;
      if (message.method === "transport/error") { if (!settled) { settled = true; fail(new ProviderFailure(abortKind ?? "interrupted", p?.message ?? "Disconnected")); } return; }
      if (!p || p.threadId !== nativeId) return;
      if (message.method === "turn/started") turnId = p.turn?.id ?? turnId;
      if (message.method === "item/agentMessage/delta") { if (typeof p.delta !== "string") throw new ProviderFailure("protocol", "Invalid text delta"); output += p.delta; if (Buffer.byteLength(output) > 10 * 1024 * 1024) throw new ProviderFailure("protocol", "Provider text exceeded limit"); emit({ type: "text", text: p.delta }); }
      if (message.method === "item/started" || message.method === "item/completed") {
        const item = p.item;
        if (item?.type === "agentMessage" && message.method === "item/completed" && !output && typeof item.text === "string") { output = item.text; emit({ type: "text", text: output }); }
        if (item && ["commandExecution", "fileChange", "mcpToolCall", "collabAgentToolCall"].includes(item.type)) emit({ type: "tool", id: item.id, name: item.type, status: item.status === "failed" || item.exitCode != null && item.exitCode !== 0 ? "failed" : message.method === "item/started" ? "started" : "completed", detail: item.command || item.tool });
      }
      if (message.method === "thread/tokenUsage/updated" && p.tokenUsage?.last) {
        const u = p.tokenUsage.last;
        usage = { type: "usage", inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedInputTokens: u.cachedInputTokens, reasoningTokens: u.reasoningOutputTokens, totalTokens: u.totalTokens }; emit(usage);
      }
      if (message.method === "turn/completed" && !settled) {
        settled = true;
        if (abortKind) fail(new ProviderFailure(abortKind, `Codex ${abortKind}`));
        else if (p.turn?.status === "completed") { emit({ type: "completed", sessionId, output }); complete({ provider: this.id, sessionId, output, configuration: effective, usage }); }
        else if (p.turn?.status === "interrupted") fail(new ProviderFailure("interrupted", "Codex turn interrupted"));
        else fail(classifyError(p.turn?.error?.message ?? "Codex turn failed"));
      }
    });
    try {
      await rpc.initialize();
      const params = { cwd, model: config.model, approvalPolicy: request.approve ? "on-request" : "never", approvalsReviewer: "user", sandbox: config.permission === "read-only" ? "read-only" : "workspace-write", config: { "features.multi_agent": false, "sandbox_workspace_write.network_access": false, ...(config.effort ? { model_reasoning_effort: config.effort } : {}) } };
      const response = owned ? await rpc.request("thread/resume", { ...params, threadId: owned.nativeId }) : await rpc.request("thread/start", params);
      if (!response.thread?.id || response.cwd !== cwd || !["readOnly", "workspaceWrite"].includes(response.sandbox?.type) || response.sandbox.type !== (config.permission === "read-only" ? "readOnly" : "workspaceWrite") || response.approvalPolicy !== params.approvalPolicy || response.approvalsReviewer !== "user") throw new ProviderFailure("permission", "Codex effective execution policy does not match the requested policy");
      if (config.model && response.model !== config.model || config.effort && response.reasoningEffort !== config.effort) throw new ProviderFailure("configuration", "Codex effective model or reasoning effort differs from the requested configuration");
      nativeId = response.thread.id;
      this.sessions.set(sessionId, { cwd, permission: config.permission, nativeId });
      effective = { ...config, model: response.model, effort: response.reasoningEffort ?? undefined, modelConfirmed: true, effortConfirmed: true, sessionId, cwd, transport: "app-server" };
      emit({ type: "session", sessionId }); emit({ type: "configuration", configuration: effective });
      if (request.signal?.aborted || controller.signal.aborted) throw new ProviderFailure(abortKind ?? "canceled", `Codex ${abortKind ?? "canceled"} before turn`);
      const result = await rpc.request("turn/start", { threadId: nativeId, input: [{ type: "text", text: request.prompt, text_elements: [] }], model: config.model, effort: config.effort, sandboxPolicy: config.permission === "read-only" ? { type: "readOnly", networkAccess: false } : { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } });
      turnId = result.turn?.id ?? turnId;
      return await terminal;
    } catch (error) {
      const failure = error instanceof ProviderFailure ? error : classifyError((error as Error).message);
      if (failure.kind === "canceled") emit({ type: "canceled", reason: failure.message });
      else emit({ type: "error", kind: failure.kind, message: failure.message, retryable: failure.retryable });
      throw failure;
    } finally { settled = true; controller.abort(); clearTimeout(timer); request.signal?.removeEventListener("abort", onAbort); unsubscribe(); await rpc.close(); }
  }
}
