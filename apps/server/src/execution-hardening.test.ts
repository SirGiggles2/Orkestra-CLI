import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runner, ensureAgyTrusted } from "./runner";
import { Store } from "./db";
import { EventHub } from "./events";
import type { PlanTask, Run } from "../../../packages/shared/types";
import { validatePlan, pathWithin, containedTaskPath, agentEnvironment } from "./security";
import { executionPermission, secureAgentArgs, assertIsolatedWorker } from "./execution-policy";
import { spawnCommand, killProcessTree, runCommand } from "./process";
import { assertJobTransition } from "./job-state";
import { once } from "node:events";
import { localOriginAllowed, localHostAllowed } from "./http-policy";
import { getConfig } from "./config";
import { applyStaging, createStaging, sealStaging, findStaging } from "./staging";
import { execFileSync } from "node:child_process";
import { parsePlanTasks } from "./cli";

const root = mkdtempSync(join(tmpdir(), "orkestra-hardening-"));
const stores: Store[] = [];
after(() => { for (const store of stores) store.flush(); rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(root, "case-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir);
  const store = new Store({ host: "127.0.0.1", port: 0, dataDir, workspaceDir: dir });
  stores.push(store);
  const runner = new Runner(store, new EventHub(), { stagingRoot: join(dir, "staging") });
  const run: Run = { id: "test", prompt: "Investigate", status: "queued", workspacePath: join(dir, "ws"), createdAt: new Date().toISOString() };
  mkdirSync(run.workspacePath);
  store.createRun(run);
  // Exercise the scheduler with a deterministic executor; no provider login or spend.
  const internal = runner as any;
  internal.controls.set(run.id, { notes: [], stop: false, children: new Set() });
  return { runner, internal, store, run, dir };
}

test("failed team agent rejects instead of returning success-shaped error text", async () => {
  const { internal, run, store } = fixture();
  for (const a of store.listAgents()) store.saveAgent({ ...a, fallbackAgentIds: [] });
  internal.runAgent = async () => { throw new Error("tool failed"); };
  await assert.rejects(internal.runTeamTask(run, { id: "a", title: "A" }, new Map()), /failed/);
});

test("failed dependency blocks its dependent and the run cannot complete", async () => {
  const { internal, run } = fixture();
  const called: string[] = [];
  internal.runAgent = async () => { throw new Error("tool failed"); };
  const original = internal.runTeamTask.bind(internal);
  internal.runTeamTask = async (...args: any[]) => { called.push(args[1].id); return original(...args); };
  const tasks: PlanTask[] = [{ id: "a", title: "A" }, { id: "b", title: "B", dependsOn: ["a"] }];
  await assert.rejects(internal.executePhaseTasks(run, tasks, new Map(), internal.controls.get(run.id)), /failed/);
  assert.deepEqual(called, ["a"]);
});

test("unresolvable DAG fails rather than reporting a completed phase", async () => {
  const { internal, run } = fixture();
  await assert.rejects(internal.executePhaseTasks(run, [
    { id: "a", title: "A", dependsOn: ["b"] }, { id: "b", title: "B", dependsOn: ["a"] },
  ], new Map()), /dependenc|cycle/i);
});

test("missing cross-phase dependency cannot be ignored", async () => {
  const { internal, run } = fixture();
  internal.runTeamTask = async () => "ok";
  await assert.rejects(internal.executePhaseTasks(run, [{ id: "a", title: "A", dependsOn: ["missing"] }], new Map()), /dependenc/i);
});

test("planner traversal is rejected before agent execution or directory creation", async () => {
  const { internal, run, dir } = fixture();
  let called = false;
  internal.runAgent = async () => { called = true; return "ok"; };
  await assert.rejects(internal.runTeamTask(run, { id: "a", title: "A", folder: "../escape" }, new Map()), /path|folder|workspace/i);
  assert.equal(called, false);
  assert.equal(existsSync(join(dir, "escape")), false);
});

test("independent edits in a shared workspace are serialized", async () => {
  const { internal, run } = fixture();
  let active = 0;
  let peak = 0;
  internal.runTeamTask = async () => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return "ok";
  };
  await internal.executePhaseTasks(run, [{ id: "a", title: "A" }, { id: "b", title: "B" }], new Map());
  assert.equal(peak, 1);
});

test("DAG validator rejects unknown, duplicate, self, cyclic and future-phase dependencies", () => {
  const cases = [[], [{ id: "a", title: "A", dependsOn: ["missing"] }],
    [{ id: "a", title: "A" }, { id: "a", title: "B" }],
    [{ id: "a", title: "A", dependsOn: ["a"] }],
    [{ id: "a", title: "A", dependsOn: ["b"] }, { id: "b", title: "B", dependsOn: ["a"] }],
    [{ id: "a", title: "A", phase: 1, dependsOn: ["b"] }, { id: "b", title: "B", phase: 2 }],
    [{ id: "a", title: "A", dependsOn: "b" }],
  ];
  for (const tasks of cases) assert.throws(() => validatePlan(tasks));
  assert.doesNotThrow(() => validatePlan([{ id: "a", title: "A" }, { id: "b", title: "B", phase: 2, dependsOn: ["a"] }]));
});

test("invalid DAG is rejected before a run starts", () => {
  const { runner, run, store } = fixture();
  assert.throws(() => runner.startTeam(run, [{ id: "a", title: "A", dependsOn: ["a"] }]), /cyclic/i);
  assert.equal(store.getRun(run.id)?.status, "queued");
});

test("path containment rejects sibling prefixes, absolute paths and junction escapes", () => {
  const { run, dir } = fixture();
  const outside = join(dir, "outside"); mkdirSync(outside);
  assert.equal(pathWithin(run.workspacePath, `${run.workspacePath}-evil`), false);
  for (const folder of ["../x", "/x", "C:/x", "C:x", "a/../../x", "a\\..\\x", "//server/share", "NUL", "a:stream", "a/.. "]) assert.throws(() => containedTaskPath(run.workspacePath, folder));
  symlinkSync(outside, join(run.workspacePath, "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => containedTaskPath(run.workspacePath, "escape/new/file.ts"), /escapes/);
  assert.equal(pathWithin(run.workspacePath, join(run.workspacePath, "escape")), false);
});

test("API output paths cannot escape through traversal or a junction", () => {
  const { internal, run, dir } = fixture();
  const outside = join(dir, "outside"); mkdirSync(outside);
  symlinkSync(outside, join(run.workspacePath, "escape"), process.platform === "win32" ? "junction" : "dir");
  for (const path of ["../bad.ts", "escape/bad.ts", "C:/bad.ts"]) assert.throws(() => internal.writeApiFiles(run.id, run.workspacePath, `\`\`\`${path}\nx\n\`\`\``));
  assert.equal(existsSync(join(outside, "bad.ts")), false);
});

test("no live approval state fails closed and stop releases approval without applying", async () => {
  const { runner, internal, run, store } = fixture();
  await assert.rejects(internal.waitForApproval(run.id), /approval state/);
  store.updateRun(run.id, { status: "running" });
  const control = internal.controls.get(run.id);
  const pending = internal.waitForApproval(run.id, control);
  assert.equal(await runner.stop(run.id), true);
  assert.equal(await pending, "discard");
  assert.equal(runner.applyPendingPhase(run.id), false);
});

test("restart preserves approval artifacts but never replays the phase cursor", () => {
  const { runner, internal, run, store, dir } = fixture();
  writeFileSync(join(run.workspacePath, ".orkestra-phase.json"), JSON.stringify({ tasks: [{ id: "a", title: "Dangerous action" }], done: [], nextPhaseIndex: 0 }));
  internal.controls.delete(run.id);
  assert.equal(runner.resumeRun(run.id), false);
  store.updateRun(run.id, { status: "running", pendingPhase: 1 });
  store.updateRun(run.id, { activeStep: "pending review" });
  const restarted = new Store({ host: "127.0.0.1", port: 0, dataDir: join(dir, "data"), workspaceDir: dir }); stores.push(restarted);
  assert.equal(restarted.getRun(run.id)?.executionState, "INTERRUPTED");
  assert.equal(restarted.getRun(run.id)?.pendingPhase, 1);
  assert.ok(restarted.listEvents(run.id).some((e) => /INTERRUPTED/.test(e.message)));
});

test("failed states cannot transition to success and state records survive reload", () => {
  const { store, run, dir } = fixture();
  store.updateRun(run.id, { status: "running" });
  store.updateRun(run.id, { status: "failed" });
  assert.throws(() => store.updateRun(run.id, { status: "completed" }), /transition/);
  assert.throws(() => assertJobTransition("COMPLETED_VERIFIED", "RUNNING"), /transition/);
  assert.equal(JSON.parse(readFileSync(join(dir, "data", "orkestra.json"), "utf8")).runs[0].executionState, "FAILED");
});

test("credential allowlist excludes control-plane, GitHub, provider and Git override secrets", () => {
  const env = agentEnvironment({ PATH: "bin", USERPROFILE: "worker", GH_TOKEN: "secret", github_token: "secret", OPENAI_API_KEY: "secret", ANTHROPIC_API_KEY: "secret", AWS_SECRET_ACCESS_KEY: "secret", GIT_CONFIG_VALUE_0: "secret", ORKESTRA_TOKEN: "secret", NODE_OPTIONS: "--require injected.js" });
  assert.equal(env.PATH, "bin");
  assert.equal(env.USERPROFILE, "worker");
  assert.ok(!Object.values(env).includes("secret"));
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.GIT_CONFIG_VALUE_0, "");
});

test("automatic trust never changes global settings", () => {
  const { dir, run } = fixture();
  const previous = process.env.USERPROFILE;
  process.env.USERPROFILE = dir;
  try {
    assert.throws(() => ensureAgyTrusted(run.workspacePath), /disabled/);
    assert.equal(existsSync(join(dir, ".gemini")), false);
  } finally { if (previous === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous; }
});

test("policy denies bypass templates, elevated permissions and writes without review", () => {
  const agent = { command: "codex", argsTemplate: ["exec"] } as any;
  const args = secureAgentArgs(agent, "read-only");
  assert.ok(args.includes("read-only"));
  assert.ok(args.includes('approval_policy="never"'));
  for (const flag of ["--dangerously-bypass-approvals-and-sandbox", "--full-auto", "--config", "--add-dir"]) assert.throws(() => secureAgentArgs({ ...agent, argsTemplate: [flag] }, "read-only"));
  assert.throws(() => executionPermission({ permission: "elevated" } as any));
  assert.throws(() => executionPermission({ permission: "workspace-write", preWriteApproval: false }));
  assert.throws(() => secureAgentArgs({ ...agent, command: "gemini" }, "read-only"), /PR-002/);
  assert.throws(() => secureAgentArgs({ ...agent, command: "agy" }, "read-only"), /adapter/);
  const previous = process.env.ORKESTRA_ISOLATED_WORKER; delete process.env.ORKESTRA_ISOLATED_WORKER;
  try { assert.throws(assertIsolatedWorker, /restricted worker/); } finally { if (previous !== undefined) process.env.ORKESTRA_ISOLATED_WORKER = previous; }
});

test("non-idempotent failure is not retried or handed to a fallback", async () => {
  const { internal, store, run } = fixture(); run.preWriteApproval = true;
  let calls = 0;
  internal.runAgent = async () => { calls++; throw new Error("429 after side effect"); };
  await assert.rejects(internal.runWithFallback(store.listAgents()[0], run, ""), /reconcile/);
  assert.equal(calls, 1);
});

test("overlapping runs cannot claim the same workspace or nested workspace", () => {
  const { runner, internal, run } = fixture();
  internal.claimWorkspace(run);
  assert.throws(() => runner.assertWorkspaceAvailable(run.workspacePath), /active run/);
  assert.throws(() => runner.assertWorkspaceAvailable(join(run.workspacePath, "child")), /active run/);
  internal.releaseWorkspace(run.id);
  assert.doesNotThrow(() => runner.assertWorkspaceAvailable(run.workspacePath));
});

test("shell metacharacters are literal process arguments on Windows", async () => {
  const input = 'value & echo hacked | %PATH% $(oops) "quoted"';
  assert.equal(await runCommand(process.execPath, ["-e", "process.stdout.write(process.argv[1])", input], "", 5000), input);
});

test("Windows cancellation kills the parent and grandchild process tree", { skip: process.platform !== "win32", timeout: 10000 }, async () => {
  const script = "const {spawn}=require('node:child_process'); const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(p.pid);setInterval(()=>{},1000)";
  const parent = spawnCommand(process.execPath, ["-e", script], {});
  const close = once(parent, "close");
  const [chunk] = await once(parent.stdout, "data");
  const grandchild = Number(chunk.toString().trim());
  assert.ok(grandchild > 0);
  await killProcessTree(parent);
  await close;
  assert.throws(() => process.kill(grandchild, 0), /ESRCH|kill/);
});

test("zero exit code with structured provider error still fails execution", async () => {
  await assert.rejects(runCommand(process.execPath, ["-e", "console.log(JSON.stringify({type:'turn.failed',error:{message:'tool failed'}}))"], "", 5000), /tool failed/);
});

test("HTTP policy rejects hostile origins, opaque previews and DNS rebinding hosts", () => {
  assert.equal(localOriginAllowed("http://localhost:5173", 8787), true);
  for (const origin of ["https://evil.example", "http://localhost.evil:8787", "null", "http://localhost:9000", "http://127.0.0.1:8787/path"]) assert.equal(localOriginAllowed(origin, 8787), false);
  assert.equal(localHostAllowed("evil.example:8787", 8787), false);
  assert.equal(localHostAllowed("localhost:8787", 8787), true);
  const previous = process.env.ORKESTRA_HOST; process.env.ORKESTRA_HOST = "0.0.0.0";
  try { assert.throws(getConfig, /Remote binding disabled/); } finally { if (previous === undefined) delete process.env.ORKESTRA_HOST; else process.env.ORKESTRA_HOST = previous; }
});

test("sealed staging applies uncommitted edits and rejects a changed approval result", async () => {
  const { run, dir } = fixture();
  const git = (args: string[], cwd = run.workspacePath) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git(["init", "-b", "main"]);
  git(["config", "core.autocrlf", "false"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@local", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "baseline"]);
  const session = await createStaging(run.workspacePath, join(dir, "staging"), run.id, 1);
  writeFileSync(join(session.worktreePath, "new.txt"), "approved content\n");
  await sealStaging(session);
  const found = await findStaging(run.workspacePath, join(dir, "staging"), run.id, 1);
  assert.equal(found?.baseCommit, session.baseCommit);
  writeFileSync(join(session.worktreePath, "new.txt"), "unapproved content\n");
  await assert.rejects(applyStaging(run.workspacePath, session), /changed after review/);
  writeFileSync(join(session.worktreePath, "new.txt"), "approved content\n");
  await applyStaging(run.workspacePath, session);
  assert.equal(readFileSync(join(run.workspacePath, "new.txt"), "utf8"), "approved content\n");
});

test("failed task marks the entire job failed without starting its dependent", async () => {
  const { internal, store, run } = fixture();
  const called: string[] = [];
  internal.runTeamTask = async (_run: Run, task: PlanTask) => { called.push(task.id); throw new Error("task failed"); };
  await internal.executeTeam(run, [{ id: "a", title: "A" }, { id: "b", title: "B", dependsOn: ["a"] }]);
  assert.equal(store.getRun(run.id)?.executionState, "FAILED");
  assert.deepEqual(called, ["a"]);
  assert.ok(!store.listEvents(run.id).some((e) => e.type === "completed"));
});

test("team result stays outside the project until explicit approval", { timeout: 10000 }, async () => {
  const { runner, internal, store, run } = fixture();
  execFileSync("git", ["init", "-b", "main"], { cwd: run.workspacePath, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@local", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "baseline"], { cwd: run.workspacePath, stdio: "ignore" });
  run.preWriteApproval = true;
  internal.runAgent = async (_agent: unknown, _run: Run, _transcript: string, _notes: unknown, opts: { cwd: string }) => { writeFileSync(join(opts.cwd, "result.txt"), "approved edit"); return "ok"; };
  const previous = process.env.ORKESTRA_ISOLATED_WORKER; process.env.ORKESTRA_ISOLATED_WORKER = "1";
  try {
    runner.startTeam(run, [{ id: "a", title: "Write result" }]);
    for (let i = 0; i < 100 && store.getRun(run.id)?.executionState !== "WAITING_FOR_APPROVAL"; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.getRun(run.id)?.executionState, "WAITING_FOR_APPROVAL");
    assert.equal(existsSync(join(run.workspacePath, "result.txt")), false);
    assert.equal(runner.applyPendingPhase(run.id), true);
    for (let i = 0; i < 100 && store.getRun(run.id)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.getRun(run.id)?.executionState, "COMPLETED_UNVERIFIED");
    assert.equal(readFileSync(join(run.workspacePath, "result.txt"), "utf8"), "approved edit");
  } finally { if (previous === undefined) delete process.env.ORKESTRA_ISOLATED_WORKER; else process.env.ORKESTRA_ISOLATED_WORKER = previous; }
});

test("missing configured agent or unknown CLI cannot silently use a different agent", async () => {
  const { internal, run } = fixture();
  let calls = 0;
  internal.runAgent = async () => { calls++; return "ok"; };
  await assert.rejects(internal.runTeamTask(run, { id: "a", title: "A", agentId: "missing" }, new Map()), /No enabled agent/);
  await assert.rejects(internal.runTeamTask(run, { id: "a", title: "A", cli: "unknown" }, new Map()), /No enabled agent/);
  assert.equal(calls, 0);
});

test("Gemini tasks never route to Antigravity", async () => {
  const { internal, run } = fixture();
  let command = "";
  internal.runAgent = async (agent: { command: string }) => { command = agent.command; return "ok"; };
  await internal.runTeamTask(run, { id: "a", title: "A", cli: "gemini" }, new Map());
  assert.equal(command, "gemini");
  await assert.rejects(internal.runTeamTask(run, { id: "b", title: "B", cli: "antigravity" }, new Map()), /separate/);
});

test("planner parsing preserves valid paths and rejects invalid plans without sanitizing them", () => {
  const valid = [{ id: "a", title: "A", folder: "src/module", dependsOn: [] }];
  assert.deepEqual(parsePlanTasks(JSON.stringify({ tasks: valid })), valid);
  for (const task of [{ id: "a", title: "A", folder: "../escape" }, { id: "a", title: "A", dependsOn: ["missing"] }, { title: "A" }]) assert.throws(() => parsePlanTasks(JSON.stringify({ tasks: [task] })));
});

test("linear pipeline fails when a required role is unavailable", async () => {
  const { internal, store, run } = fixture();
  for (const agent of store.listAgents()) store.saveAgent({ ...agent, enabled: false });
  await internal.execute(run);
  assert.equal(store.getRun(run.id)?.executionState, "FAILED");
  assert.match(store.getRun(run.id)?.summary ?? "", /No enabled agent/);
});
