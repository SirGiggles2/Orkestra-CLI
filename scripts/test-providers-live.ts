import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { ProviderEvent, NormalizedAgentConfiguration } from "../packages/shared/providers";
import { providerAdapters } from "../apps/server/src/providers";

const root = mkdtempSync(join(tmpdir(), "orkestra-live-provider-"));
const report: Record<string, unknown> = { checkedAt: new Date().toISOString(), tests: [] };
const tests = report.tests as unknown[];
const selected = new Set(process.argv.slice(2));
for (const provider of selected) assert.ok(["codex", "claude", "gemini", "antigravity"].includes(provider), `Unknown provider: ${provider}`);
const config = (provider: NormalizedAgentConfiguration["provider"], model?: string, effort?: string): NormalizedAgentConfiguration => ({ provider, model, effort, role: "investigator", skills: [], permission: "read-only", subagents: { enabled: false, maxConcurrent: 0 } });
try {
  writeFileSync(join(root, "README.md"), "ORKESTRA_LIVE_READ_7C92\n");
  if (selected.size === 0 || selected.has("codex")) {
  const codex = providerAdapters.codex;
  const probe = await codex.probe();
  const model = probe.models.find((m) => m.isDefault) ?? probe.models[0];
  assert.ok(model, "Codex must report an actual model catalog");
  const events: ProviderEvent[] = [];
  const first = await codex.run({ configuration: config("codex", model.id, model.efforts.includes("low") ? "low" : model.defaultEffort), cwd: root, prompt: "Read README.md using a tool and return its token only. Do not change any file.", timeoutMs: 120000, onEvent: (e) => events.push(e) });
  assert.match(first.output, /ORKESTRA_LIVE_READ_7C92/);
  assert.ok(events.some((e) => e.type === "tool"));
  tests.push({ provider: "codex", test: "read-only-file/streaming/configuration/usage", passed: true, model: first.configuration.model, effort: first.configuration.effort, eventTypes: [...new Set(events.map((e) => e.type))] });
  const second = await codex.run({ configuration: config("codex", model.id, model.efforts.includes("medium") ? "medium" : model.defaultEffort), cwd: root, sessionId: first.sessionId, prompt: "What token did you read in the previous turn? Reply with that token only.", timeoutMs: 120000, onEvent: () => {} });
  assert.match(second.output, /ORKESTRA_LIVE_READ_7C92/);
  assert.equal(second.sessionId, first.sessionId);
  tests.push({ provider: "codex", test: "continuation/resume/effort-change", passed: true, model: second.configuration.model, effort: second.configuration.effort });
  const alternative = probe.models.find((m) => m.id !== model.id);
  if (alternative) {
    const switched = await codex.run({ configuration: config("codex", alternative.id, alternative.defaultEffort), cwd: root, sessionId: first.sessionId, prompt: "Reply exactly ORKESTRA_MODEL_SWITCH_OK without tools.", timeoutMs: 120000, onEvent: () => {} });
    assert.match(switched.output, /ORKESTRA_MODEL_SWITCH_OK/);
    assert.equal(switched.configuration.model, alternative.id);
    tests.push({ provider: "codex", test: "model-switch", passed: true, model: switched.configuration.model });
  }
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@local", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "baseline"], { cwd: root, stdio: "ignore" });
  const writer = { ...config("codex", model.id, "low"), permission: "workspace-write" as const, role: "builder" };
  const edited = await codex.run({ configuration: writer, cwd: root, prompt: "Create probe-result.txt containing exactly ORKESTRA_WRITE_OK. Do not run shell commands or modify any other file. Use your file editing tool. Then reply done.", timeoutMs: 120000, onEvent: () => {} });
  assert.equal(readFileSync(join(root, "probe-result.txt"), "utf8").trim(), "ORKESTRA_WRITE_OK");
  tests.push({ provider: "codex", test: "disposable-workspace-write", passed: true, model: edited.configuration.model });
  }
  for (const id of ["claude", "gemini"] as const) {
    if (selected.size && !selected.has(id)) continue;
    const current = await providerAdapters[id].probe();
    try {
      const result = await providerAdapters[id].run({ configuration: config(id), cwd: root, prompt: "Read README.md and reply with its token only. Do not modify files.", timeoutMs: 60000, onEvent: () => {} });
      assert.match(result.output, /ORKESTRA_LIVE_READ_7C92/);
      tests.push({ provider: id, test: "read-only-live", passed: true, model: result.configuration.model });
    } catch (error) {
      tests.push({ provider: id, test: "read-only-live", passed: false, authentication: current.authentication, error: (error as Error).message });
    }
  }
  if (selected.size === 0 || selected.has("antigravity")) {
    const adapter = providerAdapters.antigravity;
    const probe = await adapter.probe();
    const model = probe.models.find((m) => /gemini.*flash.*low/.test(m.id)) ?? probe.models[0];
    assert.ok(model, "Antigravity must return its model catalog");
    const configuration = { ...config("antigravity", model.id), permission: "workspace-write" as const };
    const events: ProviderEvent[] = [];
    const first = await adapter.run({ configuration, cwd: root, prompt: "Read README.md using your file tool and return its token only. Do not write files or run commands.", timeoutMs: 90000, onEvent: (e) => events.push(e) });
    assert.match(first.output, /ORKESTRA_LIVE_READ_7C92/);
    assert.ok(events.some((e) => e.type === "tool"));
    assert.ok(events.some((e) => e.type === "usage"));
    tests.push({ provider: "antigravity", test: "disposable-file-read/structured-events/usage", passed: true, nativePermission: configuration.permission, model: first.configuration.model });
    const second = await adapter.run({ configuration, cwd: root, sessionId: first.sessionId, prompt: "Repeat the token you read in the previous turn. Do not use tools.", timeoutMs: 90000, onEvent: () => {} });
    assert.equal(second.sessionId, first.sessionId); assert.match(second.output, /ORKESTRA_LIVE_READ_7C92/);
    tests.push({ provider: "antigravity", test: "owned-session-continuation", passed: true });
    await adapter.run({ configuration, cwd: root, prompt: "Create agy-probe-result.txt containing exactly ORKESTRA_AGY_WRITE_OK. Use the file write tool. Do not run commands or modify anything else.", timeoutMs: 90000, onEvent: () => {} });
    assert.equal(readFileSync(join(root, "agy-probe-result.txt"), "utf8").trim(), "ORKESTRA_AGY_WRITE_OK");
    tests.push({ provider: "antigravity", test: "disposable-file-write", passed: true });
  }
} catch (error) { report.error = (error as Error).message; process.exitCode = 1; }
finally {
  mkdirSync(resolve("outputs/PR-002"), { recursive: true });
  for (const provider of ["codex", "claude", "gemini", "antigravity"]) {
    const results = tests.filter((test: any) => test.provider === provider);
    if (results.length) writeFileSync(resolve(`outputs/PR-002/live-${provider}.json`), JSON.stringify({ checkedAt: report.checkedAt, tests: results }, null, 2));
  }
  if (tests.some((test: any) => test.passed === false)) process.exitCode = 1;
  writeFileSync(resolve("outputs/PR-002/live-test-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
  rmSync(root, { recursive: true, force: true });
}
