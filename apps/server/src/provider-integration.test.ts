import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Runner } from "./runner";
import { Store } from "./db";
import { EventHub } from "./events";
import { providerAdapters } from "./providers";
import { CodexAdapter } from "./providers/codex";
import { spawnCommand } from "./process";
import { callPlannerRaw } from "./cli";
import type { Run } from "../../../packages/shared/types";

const root = mkdtempSync(join(tmpdir(), "orkestra-provider-integration-"));
const stores: Store[] = [];
after(() => { for (const store of stores) store.flush(); rmSync(root, { recursive: true, force: true }); });
const fixture = resolve("apps/server/src/providers/fixture.mjs");
const adapter = (mode = "success") => new CodexAdapter((cwd) => spawnCommand(process.execPath, [fixture, mode, "codex"], { cwd }), async () => "test");
function setup() {
  const dir = mkdtempSync(join(root, "case-"));
  const store = new Store({ host: "127.0.0.1", port: 0, dataDir: join(dir, "data"), workspaceDir: dir });
  stores.push(store);
  const run: Run = { id: "integration", prompt: "test", status: "queued", permission: "read-only", workspacePath: join(dir, "workspace"), createdAt: new Date().toISOString() };
  mkdirSync(run.workspacePath); store.createRun(run);
  const runner = new Runner(store, new EventHub(), { stagingRoot: join(dir, "staging") });
  const internal = runner as any;
  internal.controls.set(run.id, { notes: [], stop: false, children: new Set() });
  const agent = { ...store.listAgents()[0], command: "codex", argsTemplate: [], timeoutSeconds: 5 };
  store.saveAgent(agent);
  return { store, run, runner, internal, agent };
}

test("runner persists normalized provider events and releases cancellation controls", async () => {
  const previous = providerAdapters.codex; providerAdapters.codex = adapter();
  try {
    const { store, run, internal, agent } = setup();
    assert.equal(await internal.runAgent(agent, run, ""), "héllo");
    const events = store.listEvents(run.id).filter((event) => event.type === "provider_event");
    assert.ok(events.some((event) => event.message === "configuration"));
    assert.ok(events.some((event) => event.message === "usage"));
    assert.ok(events.some((event) => event.message === "completed"));
    assert.equal(internal.controls.get(run.id).aborters.size, 0);
  } finally { providerAdapters.codex = previous; }
});

test("runner stop reaches the native adapter and failed providers cannot emit completion", async () => {
  const previous = providerAdapters.codex; providerAdapters.codex = adapter("hang");
  try {
    const { store, run, internal, runner, agent } = setup();
    const pending = internal.runAgent(agent, run, "");
    const rejection = assert.rejects(pending, /canceled|Canceled/);
    for (let i = 0; i < 100 && !store.listEvents(run.id).some((event) => event.type === "provider_event" && event.message === "session"); i++) await new Promise((done) => setTimeout(done, 20));
    await runner.stop(run.id); await rejection;
    assert.equal(store.getRun(run.id)?.executionState, "CANCELED");
    assert.ok(!store.listEvents(run.id).some((event) => event.type === "provider_event" && event.message === "completed"));
  } finally { providerAdapters.codex = previous; }
});

test("planner uses the same adapter and propagates native failures", async () => {
  const previous = providerAdapters.codex;
  try {
    providerAdapters.codex = adapter();
    assert.equal(await callPlannerRaw("codex", "test", "test-model", "medium"), "héllo");
    providerAdapters.codex = adapter("quota");
    await assert.rejects(callPlannerRaw("codex", "test"), /quota exhausted/);
    await assert.rejects(callPlannerRaw("unknown", "test"), /Unknown planner/);
  } finally { providerAdapters.codex = previous; }
});

test("Antigravity chat uses a unique disposable writable workspace and cleans up on failure", async () => {
  const previous = providerAdapters.antigravity;
  let cwd = "";
  providerAdapters.antigravity = {
    id: "antigravity", probe: previous.probe.bind(previous),
    run: async (request) => {
      cwd = request.cwd;
      assert.equal(request.configuration.permission, "workspace-write");
      assert.ok(cwd.startsWith(join(tmpdir(), "orkestra-agy-chat-")));
      writeFileSync(join(cwd, "scratch.txt"), "temporary");
      throw Error("native quota failure");
    },
  };
  try { await assert.rejects(callPlannerRaw("antigravity", "test"), /native quota failure/); assert.equal(existsSync(cwd), false); }
  finally { providerAdapters.antigravity = previous; }
});
