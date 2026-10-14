import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { EffectiveAgentConfiguration, ProviderEventPayload, ProviderProbe, ProviderResult, NormalizedAgentConfiguration } from "../../../../packages/shared/providers";
import { agentEnvironment } from "../security";
import { spawnCommand, runCommand, killProcessTree } from "../process";
import { eventEmitter, classifyError, normalizeConfiguration, probeScope, unavailableCapabilities, validateRun, ProviderFailure, type ProviderAdapter, type ProviderRunRequest } from "./common";
import { JsonLineDecoder } from "./json-stream";

export type HeadlessFactory = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
export interface HeadlessOptions { spawn?: HeadlessFactory; command?: typeof runCommand; geminiEntrypoint?: string }
type StreamState = { sessionId?: string; output: string; streamed: boolean; terminal: boolean; effective: EffectiveAgentConfiguration; usage?: Extract<ProviderEventPayload, { type: "usage" }>; error?: ProviderFailure };

export function validateAntigravitySettings(settings: any) {
  if (!settings || settings.allowNonWorkspaceAccess !== false || settings.toolPermission !== "request-review" || settings.permissions?.allow?.length) throw new ProviderFailure("permission", "Managed Antigravity runs require request-review, no outside-workspace access and no persistent Allow rules");
  if (settings.modelProvider) throw new ProviderFailure("configuration", "Managed Antigravity uses account login; API billing requires an explicit API provider");
}

export function consumeAntigravity(event: any, state: StreamState, emit: (payload: ProviderEventPayload) => void) {
  if (typeof event.event !== "string") throw new ProviderFailure("protocol", "Antigravity event has no event name");
  if (event.event === "init") {
    if (!event.conversation_id || event.init?.permission_mode !== "request-review" || resolve(event.init?.cwd ?? "") !== state.effective.cwd) throw new ProviderFailure("permission", "Antigravity did not confirm the expected session, workspace and review policy");
    state.sessionId = event.conversation_id; state.effective.sessionId = event.conversation_id;
    if (typeof event.init.model === "string") { state.effective.model = event.init.model; state.effective.modelConfirmed = true; }
    emit({ type: "session", sessionId: state.sessionId! }); emit({ type: "configuration", configuration: { ...state.effective } });
  }
  if (event.event === "step_update") {
    const step = event.step_update;
    if (step?.step_type === "agent_response" && typeof step.text_delta === "string") { state.output += step.text_delta; emit({ type: "text", text: step.text_delta }); }
    if (step?.step_type === "tool") {
      emit({ type: "tool", id: String(step.step_index), name: step.tool_name || step.tool_info?.name || "tool", status: step.tool_info?.error ? "failed" : step.state === "DONE" ? "completed" : "started" });
      if (step.tool_info?.error && /permission|denied|approval/i.test(JSON.stringify(step.tool_info.error))) state.error = new ProviderFailure("permission", "Antigravity denied a requested tool");
    }
    if (step?.subagent_info) emit({ type: "diagnostic", message: "Antigravity reported native subagent activity; managed concurrency controls are unavailable" });
  }
  if (event.event === "result") {
    const result = event.result;
    state.terminal = true;
    if (result?.conversation_id !== state.sessionId) throw new ProviderFailure("protocol", "Antigravity terminal session differs from init");
    if (result.status !== "SUCCESS") state.error = classifyError(result.error || `Antigravity result: ${result.status}`);
    if (!state.output && typeof result.response === "string") { state.output = result.response; emit({ type: "text", text: result.response }); }
    if (result.usage) { state.usage = { type: "usage", inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens, cachedInputTokens: result.usage.cache_read_tokens, reasoningTokens: result.usage.thinking_tokens, totalTokens: result.usage.total_tokens }; emit(state.usage); }
  }
}

export function assertGeminiProfile(cwd: string, home = homedir()) {
  const files = new Set([join(home, ".gemini", "settings.json")]);
  for (let dir = cwd; ; dir = dirname(dir)) { files.add(join(dir, ".gemini", "settings.json")); if (dirname(dir) === dir) break; }
  for (const path of files) if (existsSync(path)) {
    let settings: any;
    try { settings = JSON.parse(readFileSync(path, "utf8")); } catch { throw new ProviderFailure("configuration", "Gemini settings unreadable; refusing unmanaged configuration"); }
    if (settings.security?.auth?.selectedType && settings.security.auth.selectedType !== "oauth-personal") throw new ProviderFailure("configuration", "Managed Gemini runs require Google sign-in. Configure an explicit API provider to use API billing.");
    if (settings.hooks && Object.keys(settings.hooks).length || settings.mcpServers && Object.keys(settings.mcpServers).length || settings.mcp?.serverCommand || settings.tools?.discoveryCommand || settings.tools?.callCommand) throw new ProviderFailure("configuration", "Custom Gemini hooks, MCP servers and discovery commands are unavailable for managed runs until run-scoped integration is implemented");
  }
}

export function consumeClaude(event: any, state: StreamState, emit: (payload: ProviderEventPayload) => void) {
  if (typeof event.type !== "string") throw new ProviderFailure("protocol", "Claude event has no type");
  if (event.type === "system" && event.subtype === "init") {
    if (typeof event.session_id !== "string" || !event.session_id) throw new ProviderFailure("protocol", "Claude did not report its session");
    state.sessionId = event.session_id; state.effective.sessionId = event.session_id;
    if (typeof event.model === "string") { state.effective.model = event.model; state.effective.modelConfirmed = true; }
    emit({ type: "session", sessionId: event.session_id }); emit({ type: "configuration", configuration: { ...state.effective } });
  }
  if (event.type === "stream_event") {
    const e = event.event;
    if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") { state.streamed = true; state.output += e.delta.text; emit({ type: "text", text: e.delta.text }); }
    if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") emit({ type: "tool", id: e.content_block.id, name: e.content_block.name, status: "started" });
  }
  if (event.type === "assistant" && !state.streamed) {
    for (const block of event.message?.content ?? []) if (block.type === "text") { state.output += block.text; emit({ type: "text", text: block.text }); }
  }
  if (event.type === "user") for (const block of event.message?.content ?? []) if (block.type === "tool_result") emit({ type: "tool", id: block.tool_use_id, name: "tool_result", status: block.is_error ? "failed" : "completed" });
  if (event.type === "result") {
    if (state.terminal) throw new ProviderFailure("protocol", "Duplicate terminal Claude result");
    state.terminal = true; state.sessionId ??= event.session_id;
    if (event.is_error || event.subtype !== "success") state.error = classifyError((event.errors ?? []).join("\n") || event.result || "Claude execution failed");
    if (Array.isArray(event.permission_denials) && event.permission_denials.length) state.error = new ProviderFailure("permission", "Claude denied one or more requested tools");
    if (!state.output && typeof event.result === "string") { state.output = event.result; emit({ type: "text", text: event.result }); }
    if (event.usage) { state.usage = { type: "usage", inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens, cachedInputTokens: event.usage.cache_read_input_tokens }; emit(state.usage); }
  }
  if (event.type === "error") state.error = classifyError(event.message ?? "Claude reported an error");
}

export function consumeGemini(event: any, state: StreamState, emit: (payload: ProviderEventPayload) => void) {
  if (typeof event.type !== "string") throw new ProviderFailure("protocol", "Gemini event has no type");
  if (event.type === "init") {
    if (typeof event.session_id !== "string" || !event.session_id) throw new ProviderFailure("protocol", "Gemini did not report its session");
    state.sessionId = event.session_id; state.effective.sessionId = event.session_id;
    if (typeof event.model === "string") { state.effective.model = event.model; state.effective.modelConfirmed = true; }
    emit({ type: "session", sessionId: event.session_id }); emit({ type: "configuration", configuration: { ...state.effective } });
  }
  if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") { state.output += event.content; emit({ type: "text", text: event.content }); }
  if (event.type === "tool_use") emit({ type: "tool", id: event.tool_id, name: event.tool_name, status: "started" });
  if (event.type === "tool_result") emit({ type: "tool", id: event.tool_id, name: event.tool_name || "tool_result", status: event.status === "error" ? "failed" : "completed" });
  if (event.type === "error") state.error = classifyError(event.message ?? event.error?.message ?? "Gemini reported an error");
  if (event.type === "result") {
    if (state.terminal) throw new ProviderFailure("protocol", "Duplicate terminal Gemini result");
    state.terminal = true;
    if (event.status !== "success") state.error = classifyError(event.error?.message ?? event.message ?? "Gemini execution failed");
    if (event.stats) { state.usage = { type: "usage", inputTokens: event.stats.input_tokens, outputTokens: event.stats.output_tokens, cachedInputTokens: event.stats.cached, totalTokens: event.stats.total_tokens }; emit(state.usage); }
  }
}

export class HeadlessAdapter implements ProviderAdapter {
  private sessions = new Map<string, { cwd: string; permission: string }>();
  constructor(readonly id: "claude" | "gemini" | "antigravity", private options: HeadlessOptions = {}) {}
  private tool() {
    if (this.id === "antigravity") {
      const native = join(homedir(), "AppData", "Local", "agy", "bin", "agy.exe");
      return { command: process.platform === "win32" && existsSync(native) ? native : "agy", prefix: [] as string[] };
    }
    const entrypoint = this.options.geminiEntrypoint ?? process.env.ORKESTRA_GEMINI_ENTRYPOINT;
    if (this.id === "gemini" && entrypoint) {
      const script = resolve(entrypoint);
      if (!existsSync(script) || !/\.(?:js|mjs|cjs)$/i.test(script)) throw new ProviderFailure("configuration", "Configured Gemini entrypoint is not a Node script");
      return { command: process.execPath, prefix: [script] };
    }
    return { command: this.id, prefix: [] as string[] };
  }
  async probe(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ProviderProbe> {
    const probe: ProviderProbe = { provider: this.id, installed: false, authentication: "unknown", authenticationSource: "unavailable", capabilities: unavailableCapabilities(), models: [], checkedAt: new Date().toISOString() };
    const scope = probeScope(options);
    try {
      const nativeCommand = this.options.command ?? runCommand, tool = this.tool();
      const command: typeof runCommand = (cmd, args, input, timeoutMs, cwd) => nativeCommand(cmd, args, input, timeoutMs, cwd, scope.signal);
      probe.version = await command(tool.command, [...tool.prefix, "--version"], "", 10_000);
      probe.installed = true;
      const help = await command(tool.command, [...tool.prefix, "--help"], "", 10_000);
      if (this.id === "antigravity") {
        const restrictions = ["--output-format", "stream-json", "--input-format", "--disable-slash-commands", "--conversation", "--mode", "accept-edits"].every((flag) => help.includes(flag));
        const configured = JSON.parse(await command(tool.command, ["-p", "/config", "--output-format", "json"], "", 10_000)).command?.data?.config;
        validateAntigravitySettings(configured);
        const catalog = await command(tool.command, ["models"], "", 10_000);
        probe.models = catalog.split(/\r?\n/).filter((line) => line.includes("\t")).map((line) => { const [id, label] = line.split("\t"); return { id, label, efforts: [], accessVerified: false }; });
        if (!probe.models.length) throw new ProviderFailure("protocol", "Antigravity returned no model catalog");
        probe.authentication = "authenticated"; probe.authenticationSource = "provider"; probe.authenticationMethod = "account";
        const efforts = help.match(/\(low\|medium\|high[^)]*\)/)?.[0].replace(/[()]/g, "").split("|") ?? [];
        for (const model of probe.models) model.efforts = efforts;
        probe.capabilities = { streaming: restrictions, sessions: true, resumption: true, modelSelection: true, modelCatalog: "provider", efforts, permissions: ["workspace-write"], approvals: "deny-only", nativeSubagents: { available: true, visibility: "events", configurableLimit: false }, skills: false };
        return probe;
      }
      const streaming = help.includes("stream-json") && help.includes("--output-format");
      const restrictions = this.id === "claude" ? ["--tools", "--permission-mode", "--strict-mcp-config", "--setting-sources"].every((flag) => help.includes(flag)) : ["--approval-mode", "plan", "--admin-policy", "--extensions", "--skip-trust"].every((flag) => help.includes(flag));
      probe.capabilities = { streaming: streaming && restrictions, sessions: help.includes("--resume"), resumption: help.includes("--resume"), modelSelection: help.includes("--model"), efforts: this.id === "claude" && help.includes("--effort") ? [...new Set((help.match(/\(low,\s*medium,\s*high[^)]*\)/)?.[0] ?? "").replace(/[()]/g, "").split(/,\s*/).filter(Boolean))] : [], modelCatalog: "unavailable", permissions: restrictions ? ["read-only"] : [], approvals: "deny-only", nativeSubagents: { available: false, visibility: "none", configurableLimit: false }, skills: false };
      if (this.id === "claude") {
        try { const auth = JSON.parse(await command(tool.command, [...tool.prefix, "auth", "status", "--json"], "", 10_000)); probe.authentication = auth.loggedIn === true ? "authenticated" : "unauthenticated"; probe.authenticationSource = "provider"; probe.authenticationMethod = auth.authMethod === "claude.ai" ? "account" : auth.authMethod === "api_key" ? "api" : "unknown"; }
        catch (error) { if (/"loggedIn"\s*:\s*false/.test((error as Error).message)) { probe.authentication = "unauthenticated"; probe.authenticationSource = "provider"; } else throw error; }
      }
    } catch (error) { const failure = scope.failure(error); probe.error = { kind: !probe.installed && !scope.signal.aborted ? "unavailable" : failure.kind, message: failure.message }; }
    return probe;
  }
  async run(request: ProviderRunRequest): Promise<ProviderResult> {
    const cwd = validateRun(request);
    const started = Date.now();
    const config = normalizeConfiguration(request.configuration, await this.probe({ signal: request.signal, timeoutMs: request.timeoutMs }));
    validateRun(request);
    const owned = request.sessionId && this.sessions.get(request.sessionId);
    if (request.sessionId && (!owned || owned.cwd !== cwd || owned.permission !== config.permission)) throw new ProviderFailure("configuration", "Session does not belong to this managed workspace and permission scope");
    const emit = eventEmitter(this.id, request.onEvent);
    const effective: EffectiveAgentConfiguration = { ...config, cwd, modelConfirmed: false, effortConfirmed: !config.effort, transport: "stream-json" };
    emit({ type: "configuration", configuration: { ...effective } });
    const state: StreamState = { output: "", streamed: false, terminal: false, effective };
    const tool = this.tool();
    const args = this.id === "claude" ? ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "dontAsk", "--tools", "Read,Glob,Grep", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--disable-slash-commands"] : ["--prompt", "Follow the task provided on stdin.", "--output-format", "stream-json", "--approval-mode", "plan", "--extensions", "none", "--skip-trust"];
    if (config.model) args.push("--model", config.model);
    if (config.effort) args.push("--effort", config.effort);
    if (this.id === "antigravity") {
      args.splice(0, args.length, "--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--mode", "accept-edits");
      if (config.model) args.push("--model", config.model);
      if (config.effort) args.push("--effort", config.effort);
    }
    if (request.sessionId) args.push(this.id === "antigravity" ? "--conversation" : "--resume", request.sessionId);
    const env = agentEnvironment();
    let scope: string | undefined;
    if (this.id === "gemini") {
      assertGeminiProfile(cwd);
      scope = mkdtempSync(join(tmpdir(), "orkestra-gemini-policy-"));
      const policy = join(scope, "policy.toml");
      writeFileSync(policy, '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 998\n\n[[rule]]\ntoolName = ["read_file", "list_directory", "glob", "grep_search", "search_file_content"]\ndecision = "allow"\npriority = 999\n');
      args.push("--admin-policy", policy); env.GEMINI_CLI_NO_RELAUNCH = "1";
    }
    try {
      await new Promise<void>((resolveRun, reject) => {
        const child = (this.options.spawn ?? spawnCommand)(tool.command, [...tool.prefix, ...args], { cwd, env });
        let error: ProviderFailure | undefined, stderr = "", aborted = false, bytes = 0;
        const stop = (failure: ProviderFailure) => { error ??= failure; aborted = true; void killProcessTree(child).catch((e) => reject(e)); };
        const decoder = new JsonLineDecoder((event) => { if (state.terminal) throw new ProviderFailure("protocol", "Provider emitted events after its terminal result"); (this.id === "claude" ? consumeClaude : this.id === "antigravity" ? consumeAntigravity : consumeGemini)(event, state, emit); });
        const onAbort = () => stop(new ProviderFailure("canceled", `${this.id} canceled`));
        request.signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => stop(new ProviderFailure("timeout", `${this.id} timed out`)), Math.max(1, request.timeoutMs - (Date.now() - started)));
        if (request.signal?.aborted) onAbort();
        child.stdin.on("error", (e) => { if ((e as NodeJS.ErrnoException).code !== "EPIPE") stop(classifyError(e.message)); });
        child.stdout.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 10 * 1024 * 1024) { stop(new ProviderFailure("protocol", "Provider output exceeded limit")); return; }
          if (!aborted) try { decoder.feed(chunk); } catch (e) { stop(e as ProviderFailure); }
        });
        child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_000); });
        const cleanup = () => { clearTimeout(timer); request.signal?.removeEventListener("abort", onAbort); };
        child.on("error", (e) => { cleanup(); reject(classifyError(e.message)); });
        child.on("close", (code) => {
          cleanup();
          if (!error) try { decoder.end(); } catch (e) { error = e as ProviderFailure; }
          if (error) reject(error);
          else if (state.error) reject(state.error);
          else if (this.id === "antigravity" && /soft.denied|permission.*denied|requires approval/i.test(stderr)) reject(new ProviderFailure("permission", "Antigravity could not obtain tool approval in headless mode"));
          else if (code !== 0) reject(classifyError(stderr || `${this.id} exited with code ${code}`));
          else if (!state.terminal || !state.sessionId) reject(new ProviderFailure("interrupted", "Provider exited without a successful terminal result and session ID"));
          else resolveRun();
        });
        child.stdin.end(this.id === "antigravity" ? JSON.stringify({ event: "user", message: { content: request.prompt } }) + "\n" : request.prompt);
      });
      if (request.sessionId && state.sessionId !== request.sessionId) throw new ProviderFailure("protocol", "Provider resumed an unexpected session");
      this.sessions.set(state.sessionId!, { cwd, permission: config.permission });
      emit({ type: "completed", sessionId: state.sessionId!, output: state.output });
      return { provider: this.id, sessionId: state.sessionId!, output: state.output, configuration: state.effective, usage: state.usage };
    } catch (error) {
      const failure = error instanceof ProviderFailure ? error : classifyError((error as Error).message);
      if (failure.kind === "canceled") emit({ type: "canceled", reason: failure.message }); else emit({ type: "error", kind: failure.kind, message: failure.message, retryable: failure.retryable });
      throw failure;
    } finally { if (scope) rmSync(scope, { recursive: true, force: true }); }
  }
}
