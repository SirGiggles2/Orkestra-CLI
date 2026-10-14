import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnCommand } from "./process";
import { CodexAdapter } from "./providers/codex";
import { HeadlessAdapter, assertGeminiProfile, validateAntigravitySettings } from "./providers/headless";
import { normalizeConfiguration, classifyError, unavailableCapabilities } from "./providers/common";
import { JsonLineDecoder } from "./providers/json-stream";
import { configurationFromAgent } from "./providers";
import type { ProviderEvent, NormalizedAgentConfiguration, ProviderProbe } from "../../../packages/shared/providers";

const root = mkdtempSync(join(tmpdir(), "orkestra-adapter-tests-"));
after(() => rmSync(root, { recursive: true, force: true }));
const fixture = resolve("apps/server/src/providers/fixture.mjs");
const config = (provider: NormalizedAgentConfiguration["provider"]): NormalizedAgentConfiguration => ({ provider, role: "investigator", skills: [], permission: "read-only", subagents: { enabled: false, maxConcurrent: 0 } });
const command = async (_command: string, args: string[]) => args.includes("--version") ? "test 1.0" : args.includes("auth") ? '{"loggedIn":true,"authMethod":"claude.ai"}' : "--tools --permission-mode --strict-mcp-config --setting-sources --output-format stream-json --resume --model --effort (low, medium, high) --approval-mode plan --admin-policy --extensions --skip-trust";
const codex = (mode = "success") => new CodexAdapter((cwd) => spawnCommand(process.execPath, [fixture, mode, "codex"], { cwd }), command);
const headless = (id: "claude" | "gemini", mode = "success") => new HeadlessAdapter(id, { command, spawn: (_cmd, _args, options) => spawnCommand(process.execPath, [fixture, mode, id], options) });
const request = (provider: NormalizedAgentConfiguration["provider"], events: ProviderEvent[] = []) => ({ configuration: config(provider), cwd: root, prompt: "test", timeoutMs: 5000, onEvent: (e: ProviderEvent) => events.push(e) });

test("JSON event decoder preserves split UTF-8 and enforces frame limits", () => {
  const values: unknown[] = [], decoder = new JsonLineDecoder((value) => values.push(value));
  const bytes = Buffer.from('{"text":"héllo"}\n');
  for (const byte of bytes) decoder.feed(Buffer.from([byte]));
  decoder.end(); assert.deepEqual(values, [{ text: "héllo" }]);
  assert.throws(() => new JsonLineDecoder(() => {}, 4).feed(Buffer.from("abcdef")), /limit/);
  assert.throws(() => new JsonLineDecoder(() => {}).feed(Buffer.from("garbage\n")), /Malformed/);
});

test("configuration rejects unavailable providers, unsupported controls and fake catalog models", async () => {
  const probe = await codex().probe();
  assert.equal(probe.authentication, "authenticated");
  assert.equal(probe.models[0].accessVerified, false);
  for (const change of [{ model: "imaginary" }, { effort: "ultra" }, { skills: ["fake"] }, { subagents: { enabled: true, maxConcurrent: 2 } }, { permission: "elevated" }]) assert.throws(() => normalizeConfiguration({ ...config("codex"), ...change } as any, probe));
  const absent: ProviderProbe = { provider: "gemini", installed: false, authentication: "unknown", authenticationSource: "unavailable", capabilities: unavailableCapabilities(), models: [], checkedAt: "test" };
  assert.throws(() => normalizeConfiguration(config("gemini"), absent), /not installed/);
  assert.throws(() => normalizeConfiguration(config("codex"), { ...probe, authenticationMethod: "api" }), /API billing/);
});

test("stored agent templates cannot inject unsafe execution flags or misroute Gemini", () => {
  assert.throws(() => configurationFromAgent({ command: "codex", argsTemplate: ["--dangerously-bypass-approvals-and-sandbox"], role: "builder" } as any, "read-only"));
  const actual = configurationFromAgent({ command: "gemini", argsTemplate: ["-m", "test-model"], role: "reviewer" } as any, "read-only");
  assert.equal(actual.provider, "gemini"); assert.equal(actual.model, "test-model");
});

test("Codex streams text/tools/usage and confirms effective configuration", async () => {
  const events: ProviderEvent[] = [];
  const result = await codex().run({ ...request("codex", events), configuration: { ...config("codex"), model: "test-model", effort: "medium" } });
  assert.equal(result.output, "héllo"); assert.equal(result.configuration.effort, "medium"); assert.equal(result.configuration.modelConfirmed, true);
  assert.ok(events.some((e) => e.type === "tool")); assert.ok(events.some((e) => e.type === "usage"));
  assert.deepEqual(events.map((e) => e.sequence), events.map((_, i) => i + 1));
});

test("Codex sessions continue only in the same managed workspace and permission scope", async () => {
  const adapter = codex();
  const first = await adapter.run(request("codex"));
  const second = await adapter.run({ ...request("codex"), sessionId: first.sessionId });
  assert.equal(second.sessionId, first.sessionId);
  const other = mkdtempSync(join(root, "other-"));
  await assert.rejects(adapter.run({ ...request("codex"), cwd: other, sessionId: first.sessionId }), /Session/);
  await assert.rejects(adapter.run({ ...request("codex"), sessionId: "unowned" }), /Session/);
});

test("Codex quota, interruption, disconnect, malformed frames and policy drift fail safely", async () => {
  for (const mode of ["quota", "interrupted", "disconnect", "malformed", "unsafe-policy"]) {
    const events: ProviderEvent[] = [];
    await assert.rejects(codex(mode).run(request("codex", events)));
    assert.ok(!events.some((e) => e.type === "completed"));
  }
});

test("Codex native approvals fail closed, honor explicit one-shot decisions, and reject scope escapes", async () => {
  assert.equal((await codex("approval").run(request("codex"))).output, "decline");
  assert.equal((await codex("approval").run({ ...request("codex"), approve: async () => "approve" })).output, "accept");
  assert.equal((await codex("approval").run({ ...request("codex"), approve: async () => { throw Error("missing state"); } })).output, "decline");
  let called = false;
  assert.equal((await codex("approval-escape").run({ ...request("codex"), approve: async () => { called = true; return "approve"; } })).output, "decline");
  assert.equal(called, false);
  for (const mode of ["approval-grant", "approval-network"]) {
    called = false;
    const actual = await codex(mode).run({ ...request("codex"), configuration: { ...config("codex"), permission: "workspace-write" }, approve: async () => { called = true; return "approve"; } });
    assert.equal(actual.output, "decline"); assert.equal(called, false);
  }
});

test("Codex cancellation and timeout reject rather than complete", async () => {
  const controller = new AbortController();
  const pending = codex("hang").run({ ...request("codex"), signal: controller.signal, onEvent: (e) => { if (e.type === "session") controller.abort(); } });
  await assert.rejects(pending, /canceled|Canceled/);
  await assert.rejects(codex("hang").run({ ...request("codex"), timeoutMs: 400 }), (error: any) => error.kind === "timeout");
});

test("startup probes honor cancellation and the overall timeout without starting inference", async () => {
  await assert.rejects(codex("hang-probe").run({ ...request("codex"), timeoutMs: 400 }), /probe timed out/);
  const controller = new AbortController();
  const pending = codex("hang-probe").run({ ...request("codex"), signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(pending, /probe canceled/);
  let spawned = false;
  const adapter = new HeadlessAdapter("claude", {
    command: (_cmd, _args, _input, _timeout, _cwd, signal) => new Promise((_resolve, reject) => { signal!.addEventListener("abort", () => reject(Error("aborted")), { once: true }); }),
    spawn: () => { spawned = true; throw Error("unexpected inference"); },
  });
  await assert.rejects(adapter.run({ ...request("claude"), timeoutMs: 100 }), /probe timed out/);
  assert.equal(spawned, false);
});

for (const id of ["claude", "gemini"] as const) {
  test(`${id} structured output includes real session/model/tools/usage`, async () => {
    const events: ProviderEvent[] = [];
    const result = await headless(id).run(request(id, events));
    assert.equal(result.output, "héllo"); assert.equal(result.configuration.model, "test-model"); assert.equal(result.configuration.modelConfirmed, true);
    assert.equal(result.sessionId, "session-test");
    assert.ok(events.some((e) => e.type === "tool")); assert.ok(events.some((e) => e.type === "usage"));
  });
  test(`${id} zero-exit errors and missing terminal results cannot succeed`, async () => {
    for (const mode of ["quota", "malformed", "missing-terminal"]) await assert.rejects(headless(id, mode).run(request(id)));
  });
  test(`${id} cancellation, timeout and unavailable write mode fail closed`, async () => {
    await assert.rejects(headless(id).run({ ...request(id), configuration: { ...config(id), permission: "workspace-write" } }), /does not support/);
    await assert.rejects(headless(id, "hang").run({ ...request(id), timeoutMs: 400 }), /timed out/);
    const controller = new AbortController(); const pending = headless(id, "hang").run({ ...request(id), signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, /canceled/);
  });
  test(`${id} resumption is explicit and rejects unowned sessions`, async () => {
    const adapter = headless(id), first = await adapter.run(request(id));
    assert.equal((await adapter.run({ ...request(id), sessionId: first.sessionId })).sessionId, first.sessionId);
    await assert.rejects(adapter.run({ ...request(id), sessionId: "not-managed" }), /Session/);
  });
}

test("observed Claude quota and Gemini service rejection have distinct error classifications", () => {
  assert.equal(classifyError("You've hit your limit · resets 3pm").kind, "quota");
  assert.equal(classifyError("IneligibleTierError: UNSUPPORTED_CLIENT").kind, "unavailable");
  assert.equal(classifyError("429 too many requests").retryable, true);
  assert.equal(classifyError("API key required").kind, "authentication");
});

test("Gemini profile check rejects custom startup hooks and discovery commands", () => {
  const isolated = mkdtempSync(join(root, "profile-"));
  mkdirSync(join(isolated, ".gemini"));
  writeFileSync(join(isolated, ".gemini", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ command: "unsafe" }] } }));
  assert.throws(() => assertGeminiProfile(isolated, isolated), /Custom Gemini/);
  writeFileSync(join(isolated, ".gemini", "settings.json"), JSON.stringify({ tools: { discoveryCommand: "unsafe" } }));
  assert.throws(() => assertGeminiProfile(isolated, isolated), /Custom Gemini/);
  writeFileSync(join(isolated, ".gemini", "settings.json"), "{}");
  assert.doesNotThrow(() => assertGeminiProfile(isolated, isolated));
  writeFileSync(join(isolated, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }));
  assert.throws(() => assertGeminiProfile(isolated, isolated), /API billing/);
});

const agy = (mode = "success") => new HeadlessAdapter("antigravity", {
  command: async (_cmd, args) => args.includes("--version") ? "1.3.5" : args.includes("/config") ? JSON.stringify({ command: { data: { config: { toolPermission: "request-review", allowNonWorkspaceAccess: false } } } }) : args[0] === "models" ? "test-model\tTest model" : "--output-format stream-json --input-format --disable-slash-commands --conversation --model --effort (low|medium|high|xhigh|max) --mode accept-edits",
  spawn: (_cmd, args, options) => {
    assert.ok(args.includes("--input-format")); assert.ok(args.includes("--disable-slash-commands"));
    assert.ok(!args.some((arg) => arg.includes("dangerously")));
    return spawnCommand(process.execPath, [fixture, mode, "antigravity"], options);
  },
});
const agyRequest = (events: ProviderEvent[] = []) => ({ ...request("antigravity", events), configuration: { ...config("antigravity"), permission: "workspace-write" as const, model: "test-model", effort: "low" } });

test("Antigravity is a separate provider with an actual catalog and explicit writable scope", async () => {
  const adapter = agy(), events: ProviderEvent[] = [], probe = await adapter.probe();
  assert.deepEqual(probe.capabilities.permissions, ["workspace-write"]);
  assert.equal(probe.models[0].id, "test-model");
  await assert.rejects(adapter.run(request("antigravity")), /does not support read-only/);
  const first = await adapter.run(agyRequest(events));
  assert.equal(first.output, "héllo"); assert.equal(first.configuration.model, "test-model");
  assert.equal(first.configuration.effortConfirmed, false);
  assert.ok(events.some((event) => event.type === "tool")); assert.ok(events.some((event) => event.type === "usage"));
  assert.equal((await adapter.run({ ...agyRequest(), sessionId: first.sessionId })).sessionId, first.sessionId);
  await assert.rejects(adapter.run({ ...agyRequest(), sessionId: "unowned" }), /Session/);
});

test("Antigravity rejects policy drift, soft tool denials, zero-exit failures and incomplete results", async () => {
  for (const mode of ["unsafe-policy", "quota", "denied", "malformed", "missing-terminal"]) {
    const events: ProviderEvent[] = [];
    await assert.rejects(agy(mode).run(agyRequest(events)));
    assert.ok(!events.some((event) => event.type === "completed"));
  }
  for (const settings of [{ toolPermission: "always-proceed", allowNonWorkspaceAccess: false }, { toolPermission: "request-review", allowNonWorkspaceAccess: true }, { toolPermission: "request-review", allowNonWorkspaceAccess: false, permissions: { allow: ["command(*)"] } }, { toolPermission: "request-review", allowNonWorkspaceAccess: false, modelProvider: "gemini" }]) assert.throws(() => validateAntigravitySettings(settings));
});

test("Antigravity cancels the process tree and respects the overall deadline", async () => {
  await assert.rejects(agy("hang").run({ ...agyRequest(), timeoutMs: 400 }), (error: any) => error.kind === "timeout");
  const controller = new AbortController(), pending = agy("hang").run({ ...agyRequest(), signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, (error: any) => error.kind === "canceled");
});
