import { execFile, execFile as execFileCb } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DiffFile } from "./git";
import { containedTaskPath, agentEnvironment } from "./security";

const exec = promisify(execFileCb);

// Pre-write diff approval: per-phase git worktree as a staging area.
// The agent runs in the worktree (not the main workspace). On apply,
// the staging branch is fast-forward-merged into the workspace's current
// branch. On discard, the worktree + branch are removed.
//
// File layout: <stagingRoot>/<runId>/phase-<n>
//   - worktreePath = stagingRoot/runId/phase-n  (the live working tree)
//   - branch       = orkestra/phase-<n>        (per-phase branch)
//
// We never write into the workspace until the user approves.

export type StagingSession = {
  runId: string;
  phaseIndex: number;
  branch: string;
  worktreePath: string;
  baseCommit: string;
  reviewedCommit?: string;
};

export type GitRunner = (cwd: string, args: string[], stdin?: string) => Promise<{ stdout: string; code: number }>;

const defaultGit: GitRunner = async (cwd, args) => {
  try {
    const { stdout } = await exec("git", ["-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, ...args], { cwd, env: agentEnvironment(), windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { stdout, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; code?: number };
    return { stdout: err.stdout ?? "", code: err.code ?? 1 };
  }
};

export function branchName(phaseIndex: number): string {
  return `orkestra/phase-${phaseIndex}`;
}

export function worktreePathFor(stagingRoot: string, runId: string, phaseIndex: number): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId) || !Number.isSafeInteger(phaseIndex) || phaseIndex < 0) throw new Error("Invalid staging identity");
  return containedTaskPath(stagingRoot, `${runId}/phase-${phaseIndex}`);
}

/**
 * Create a new staging worktree branched from the workspace's current HEAD.
 * Throws if a worktree with the same branch already exists, or if the
 * workspace is not a git repository.
 */
export async function createStaging(
  workspacePath: string,
  stagingRoot: string,
  runId: string,
  phaseIndex: number,
  git: GitRunner = defaultGit
): Promise<StagingSession> {
  const branch = branchName(phaseIndex);
  const worktreePath = worktreePathFor(stagingRoot, runId, phaseIndex);
  if (existsSync(worktreePath)) {
    throw new Error(`Staging worktree already exists: ${worktreePath}`);
  }
  const { code: revParse } = await git(workspacePath, ["rev-parse", "--git-dir"]);
  if (revParse !== 0) {
    throw new Error(`Workspace is not a git repository: ${workspacePath}`);
  }
  const status = await git(workspacePath, ["status", "--porcelain"]);
  if (status.code !== 0 || status.stdout.trim()) throw new Error("Workspace must be clean before staging; preserve and reconcile existing changes first");
  const { code, stdout } = await git(workspacePath, [
    "worktree", "add", "-b", branch, worktreePath, "HEAD",
  ]);
  if (code !== 0) {
    throw new Error(`git worktree add failed for phase ${phaseIndex}: ${stdout}`);
  }
  // Capture the base commit so getStagingDiff can compare against the exact
  // point the branch was created — even if the worktree's HEAD has advanced.
  const { stdout: baseCommit, code: baseCode } = await git(workspacePath, ["rev-parse", "HEAD"]);
  if (baseCode !== 0 || !baseCommit.trim()) {
    throw new Error(`Failed to read base commit for phase ${phaseIndex}.`);
  }
  const session = { runId, phaseIndex, branch, worktreePath, baseCommit: baseCommit.trim() };
  writeFileSync(`${worktreePath}.json`, JSON.stringify(session), "utf8");
  return session;
}

/**
 * Apply: fast-forward the workspace's current branch to the staging branch,
 * then remove the worktree and delete the staging branch.
 * Throws if fast-forward is not possible (i.e. the workspace moved on).
 */
export async function applyStaging(
  workspacePath: string,
  session: StagingSession,
  git: GitRunner = defaultGit
): Promise<void> {
  if (session.reviewedCommit) {
    const head = await git(session.worktreePath, ["rev-parse", "HEAD"]);
    const branch = await git(workspacePath, ["rev-parse", session.branch]);
    const dirty = await git(session.worktreePath, ["status", "--porcelain"]);
    if (head.code !== 0 || branch.code !== 0 || dirty.code !== 0 || dirty.stdout.trim() || head.stdout.trim() !== session.reviewedCommit || branch.stdout.trim() !== session.reviewedCommit) throw new Error("Staging changed after review; a new approval is required");
  }
  const status = await git(workspacePath, ["status", "--porcelain"]);
  if (status.code !== 0 || status.stdout.trim()) throw new Error("Workspace changed during review; reconcile before applying");
  const { code: mergeCode, stdout: mergeOut } = await git(workspacePath, [
    "merge", "--ff-only", session.branch,
  ]);
  if (mergeCode !== 0) {
    throw new Error(
      `Fast-forward merge failed (workspace may have advanced): ${mergeOut}. ` +
      `Resolve manually with \`git merge ${session.branch}\` from ${workspacePath}.`
    );
  }
  await cleanup(workspacePath, session, git);
}

/**
 * Discard: drop the worktree and the branch without touching the workspace.
 */
export async function discardStaging(
  workspacePath: string,
  session: StagingSession,
  git: GitRunner = defaultGit
): Promise<void> {
  await cleanup(workspacePath, session, git);
}

async function cleanup(workspacePath: string, session: StagingSession, git: GitRunner) {
  await git(workspacePath, ["worktree", "remove", "--force", session.worktreePath]);
  await git(workspacePath, ["branch", "-D", session.branch]);
}

/**
 * Detect an existing staging session for a given (runId, phaseIndex).
 * Returns the session if both the worktree and the branch are present.
 */
export async function findStaging(
  workspacePath: string,
  stagingRoot: string,
  runId: string,
  phaseIndex: number,
  git: GitRunner = defaultGit
): Promise<StagingSession | null> {
  const branch = branchName(phaseIndex);
  const worktreePath = worktreePathFor(stagingRoot, runId, phaseIndex);
  if (!existsSync(worktreePath)) return null;
  const { code, stdout } = await git(workspacePath, ["branch", "--list", branch]);
  if (code !== 0 || !stdout.trim()) return null;
  if (existsSync(`${worktreePath}.json`)) {
    const saved = JSON.parse(readFileSync(`${worktreePath}.json`, "utf8")) as StagingSession;
    if (saved.runId !== runId || saved.phaseIndex !== phaseIndex || saved.branch !== branch || saved.worktreePath !== worktreePath || !/^[0-9a-f]{40,64}$/.test(saved.baseCommit)) throw new Error("Invalid staging metadata");
    return saved;
  }
  throw new Error("Staging metadata missing; reconciliation required");
}

// Freeze the complete result before emitting an approval request. CLI agents
// often leave uncommitted edits; a merge alone would lose those edits.
export async function sealStaging(session: StagingSession, git: GitRunner = defaultGit): Promise<void> {
  for (const args of [
    ["add", "-A"],
    ["-c", "user.name=Orkestra", "-c", "user.email=orkestra@local", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Orkestra result awaiting review"],
  ]) {
    const result = await git(session.worktreePath, args);
    if (result.code !== 0) throw new Error(`Cannot seal staging: ${result.stdout}`);
  }
  const head = await git(session.worktreePath, ["rev-parse", "HEAD"]);
  if (head.code !== 0) throw new Error("Cannot read sealed commit");
  session.reviewedCommit = head.stdout.trim();
  writeFileSync(`${session.worktreePath}.json`, JSON.stringify(session), "utf8");
}

/**
 * Get the diff of the staging worktree vs the workspace branch point.
 * Runs `git diff HEAD` from inside the worktree so uncommitted changes
 * from the agent are included (via add -N intent-to-add).
 */
export async function getStagingDiff(session: StagingSession, git: GitRunner = defaultGit): Promise<DiffFile[]> {
  const cwd = session.worktreePath;
  const pathspec = ["--", ".", ":(exclude)node_modules", ":(exclude)dist", ":(exclude).next", ":(exclude).cache", ":(exclude).git"];
  await git(cwd, ["add", "-N", ...pathspec]);
  const base = session.baseCommit || "HEAD";
  const { stdout: numstat } = await git(cwd, ["diff", base, "--numstat", ...pathspec]);
  const { stdout: full } = await git(cwd, ["diff", base, ...pathspec]);
  await git(cwd, ["reset", "-q"]);
  const diffByPath = splitUnifiedDiff(full);
  const files: DiffFile[] = [];
  for (const line of numstat.split(/\r?\n/).filter(Boolean)) {
    const cols = line.split("\t");
    const adds = cols[0];
    const dels = cols[1];
    const path = cols.slice(2).join("\t");
    if (!path) continue;
    const binary = adds === "-" || dels === "-";
    files.push({
      path,
      adds: binary ? 0 : Number(adds) || 0,
      dels: binary ? 0 : Number(dels) || 0,
      diff: binary ? "" : (diffByPath.get(path) ?? ""),
      binary,
    });
    if (files.length >= 500) break;
  }
  return files;
}

// Local copy of git.ts#splitUnifiedDiff — kept private there. Single-purpose
// parser for `git diff` output keyed by the b/ path.
function splitUnifiedDiff(full: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!full || !full.trim()) return map;
  const parts = full.split(/\r?\n(?=diff --git )/);
  for (const part of parts) {
    const header = part.startsWith("diff --git ") ? part : `diff --git ${part}`;
    const first = header.split(/\r?\n/, 1)[0];
    let path = "";
    const bm = first.match(/ b\/(.+)$/);
    if (bm) path = bm[1].trim();
    else {
      const pp = header.match(/^\+\+\+ b\/(.+)$/m);
      if (pp) path = pp[1].trim();
    }
    if (path) map.set(path, header);
  }
  return map;
}

// Avoid "execFile is unused" — kept for future direct-spawn helpers.
void execFile;
