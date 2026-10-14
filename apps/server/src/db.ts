import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, AgentRole, AgentStatus, Run, RunEvent } from "../../../packages/shared/types";
import type { AppConfig } from "./config";
import { loadApiProviderAgents } from "./apiProviders";
import { assertJobTransition, type JobState } from "./job-state";

// Derlemesiz, native-bağımlılıksız depo: veriyi bellekte tutar, tek JSON dosyasına yazar.
// (Eski better-sqlite3 yerine — böylece her Node sürümünde, Python/build-tools olmadan kurulur.)
// Public API better-sqlite3 sürümüyle birebir aynıdır; index.ts/runner.ts değişmez.

interface DbShape {
  agents: Agent[];
  runs: Run[];
  events: RunEvent[];
  eventSeq: number;
}

const MAX_RUNS = 100; // dosyayı sınırlı tut: en yeni 100 run + olayları saklanır.

export class Store {
  private file: string;
  private data: DbShape;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: AppConfig) {
    mkdirSync(config.dataDir, { recursive: true });
    this.file = join(config.dataDir, "orkestra.json");
    this.data = this.load();
    this.seedAgents();
    this.repairDefaultAgentRoles();
    for (const run of this.data.runs) {
      run.executionState ??= run.status === "completed" ? "COMPLETED_UNVERIFIED" : run.status === "failed" ? "FAILED" : run.status === "running" ? "RUNNING" : "QUEUED";
      if (["QUEUED", "ASSIGNED", "RUNNING", "WAITING_FOR_APPROVAL", "VERIFYING"].includes(run.executionState)) {
        this.updateRun(run.id, { status: "failed", executionState: "INTERRUPTED", activeStep: "interrupted", summary: "Server restarted. Reconcile side effects and pending approvals before submitting a new run.", completedAt: new Date().toISOString() });
      }
    }
  }

  private load(): DbShape {
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<DbShape>;
        return {
          agents: raw.agents ?? [],
          runs: raw.runs ?? [],
          events: raw.events ?? [],
          eventSeq: raw.eventSeq ?? 0
        };
      } catch (error) {
        throw new Error(`Job store unreadable; refusing to reset execution history: ${(error as Error).message}`);
      }
    }
    return { agents: [], runs: [], events: [], eventSeq: 0 };
  }

  // Disk yazımını kısa süre topla (run sırasında çok sık olay → diski boğmamak için).
  private persist() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 150);
  }

  // Senkron, atomik yazım (çıkışta da çağrılabilir).
  flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), "utf8");
    renameSync(tmp, this.file);
  }

  private seedAgents() {
    const defaults: Agent[] = [
      {
        id: "codex-planner",
        name: "GPT Planner",
        role: "planner",
        command: "dry-run",
        argsTemplate: ["planner", "{prompt}"],
        enabled: true,
        timeoutSeconds: 120,
        fallbackAgentIds: ["gemini-reviewer"],
        limitPatterns: defaultLimitPatterns(),
        status: "available",
        lastLimitedAt: null
      },
      {
        id: "claude-builder",
        name: "Claude Builder",
        role: "builder",
        command: "dry-run",
        argsTemplate: ["builder", "{prompt}"],
        enabled: true,
        timeoutSeconds: 180,
        fallbackAgentIds: ["codex-planner"],
        limitPatterns: defaultLimitPatterns(),
        status: "available",
        lastLimitedAt: null
      },
      {
        id: "gemini-reviewer",
        name: "Gemini Reviewer",
        role: "reviewer",
        command: "dry-run",
        argsTemplate: ["reviewer", "{prompt}"],
        enabled: true,
        timeoutSeconds: 120,
        fallbackAgentIds: ["codex-planner"],
        limitPatterns: defaultLimitPatterns(),
        status: "available",
        lastLimitedAt: null
      },
      {
        id: "codex-fixer",
        name: "Codex Fixer",
        role: "fixer",
        command: "dry-run",
        argsTemplate: ["fixer", "{prompt}"],
        enabled: true,
        timeoutSeconds: 120,
        fallbackAgentIds: ["claude-builder"],
        limitPatterns: defaultLimitPatterns(),
        status: "available",
        lastLimitedAt: null
      }
    ];

    for (const agent of defaults) {
      if (!this.getAgent(agent.id)) this.saveAgent(agent);
    }

    for (const agent of loadApiProviderAgents()) {
      const existing = this.getAgent(agent.id);
      this.saveAgent({ ...agent, status: existing?.status ?? agent.status, lastLimitedAt: existing?.lastLimitedAt ?? null });
    }
  }

  private repairDefaultAgentRoles() {
    const expected: Array<{ id: string; role: AgentRole }> = [
      { id: "codex-planner", role: "planner" },
      { id: "claude-builder", role: "builder" },
      { id: "gemini-reviewer", role: "reviewer" },
      { id: "codex-fixer", role: "fixer" }
    ];

    for (const item of expected) {
      const agent = this.getAgent(item.id);
      if (agent && agent.role !== item.role) {
        this.saveAgent({ ...agent, role: item.role });
      }
    }
  }

  listAgents(): Agent[] {
    return [...this.data.agents].sort(
      (a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name)
    );
  }

  getAgent(id: string): Agent | undefined {
    const found = this.data.agents.find((a) => a.id === id);
    return found ? { ...found } : undefined;
  }

  saveAgent(agent: Agent) {
    const idx = this.data.agents.findIndex((a) => a.id === agent.id);
    const clean: Agent = { ...agent };
    if (idx >= 0) this.data.agents[idx] = clean;
    else this.data.agents.push(clean);
    this.persist();
  }

  deleteAgent(id: string) {
    this.data.agents = this.data.agents.filter((a) => a.id !== id);
    this.persist();
  }

  setAgentStatus(id: string, status: AgentStatus, lastLimitedAt?: string) {
    const agent = this.data.agents.find((a) => a.id === id);
    if (!agent) return;
    agent.status = status;
    if (lastLimitedAt !== undefined) agent.lastLimitedAt = lastLimitedAt;
    this.persist();
  }

  createRun(run: Run) {
    if (this.getRun(run.id)) throw new Error("Duplicate run ID");
    this.data.runs.push({ ...run, executionState: "QUEUED" });
    // Dosyayı sınırlı tut: en yeni MAX_RUNS run + ilgili olaylar kalsın.
    if (this.data.runs.length > MAX_RUNS) {
      this.data.runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const active = this.data.runs.filter((r) => r.status === "queued" || r.status === "running");
      const terminal = this.data.runs.filter((r) => r.status !== "queued" && r.status !== "running").slice(0, MAX_RUNS);
      const kept = [...active, ...terminal];
      const keptIds = new Set(kept.map((r) => r.id));
      this.data.runs = kept;
      this.data.events = this.data.events.filter((e) => keptIds.has(e.runId));
    }
    this.persist();
  }

  updateRun(id: string, patch: Partial<Run>) {
    const run = this.data.runs.find((r) => r.id === id);
    if (!run) return;
    const from = run.executionState ?? "QUEUED";
    let to: JobState = patch.executionState ?? from;
    if (!patch.executionState) {
      if (patch.status === "failed") to = patch.activeStep === "stopped" || patch.activeStep === "discarded" ? "CANCELED" : "FAILED";
      else if (patch.status === "completed") to = "COMPLETED_UNVERIFIED";
      else if (patch.status === "running") to = "RUNNING";
      else if (/pending review|awaiting/.test(patch.activeStep ?? "")) to = "WAITING_FOR_APPROVAL";
    }
    // Repeated failure cleanup must preserve terminal cancellation/interruption.
    if (["CANCELED", "INTERRUPTED"].includes(from) && patch.status === "failed" && !patch.executionState) to = from;
    assertJobTransition(from, to);
    const expectedStatus = to === "QUEUED" || to === "ASSIGNED" ? "queued" : to.startsWith("COMPLETED_") ? "completed" : ["FAILED", "CANCELED", "INTERRUPTED"].includes(to) ? "failed" : "running";
    if (patch.status && patch.status !== expectedStatus) throw new Error("Job status contradicts its execution state");
    Object.assign(run, patch, { executionState: to, status: expectedStatus });
    if (from !== to) this.data.events.push({ id: ++this.data.eventSeq, runId: id, type: "state_changed", message: `${from} → ${to}`, createdAt: new Date().toISOString() });
    this.flush();
  }

  listRuns(): Run[] {
    return [...this.data.runs]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 50)
      .map((r) => ({ ...r }));
  }

  getRun(id: string): Run | undefined {
    const found = this.data.runs.find((r) => r.id === id);
    return found ? { ...found } : undefined;
  }

  addEvent(event: Omit<RunEvent, "id">): RunEvent {
    const full: RunEvent = { ...event, id: ++this.data.eventSeq };
    this.data.events.push(full);
    this.persist();
    return { ...full };
  }

  listEvents(runId: string): RunEvent[] {
    return this.data.events
      .filter((e) => e.runId === runId)
      .sort((a, b) => a.id - b.id)
      .map((e) => ({ ...e }));
  }
}

export function defaultLimitPatterns() {
  return ["rate limit", "usage limit", "quota", "try again later", "429", "login expired"];
}
