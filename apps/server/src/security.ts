import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import type { PlanTask } from "../../../packages/shared/types";

// Resolve existing ancestors as well as the leaf: catches junction/symlink escapes
// even when the requested child does not exist yet. Not an OS sandbox or a TOCTOU guard.
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync.native(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) throw new Error(`Cannot resolve path: ${path}`);
  return join(canonicalPath(parent), relative(parent, absolute));
}

export function pathWithin(root: string, target: string): boolean {
  try {
    const delta = relative(canonicalPath(root), canonicalPath(target));
    return delta === "" || (!isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
  } catch { return false; }
}

export function validateFolder(folder: unknown): asserts folder is string | undefined {
  if (folder === undefined || folder === "") return;
  if (typeof folder !== "string" || isAbsolute(folder) || win32.isAbsolute(folder) ||
      /[\x00-\x1f:]/.test(folder) || folder.includes("\\") ||
      folder.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("Invalid task folder: use a relative workspace path without traversal");
  }
}

export function containedTaskPath(root: string, folder?: string): string {
  validateFolder(folder);
  const target = resolve(root, folder || ".");
  if (!pathWithin(root, target)) throw new Error("Task path escapes approved workspace");
  return target;
}

export function validatePlan(tasks: unknown): asserts tasks is PlanTask[] {
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 200) throw new Error("Plan must contain 1–200 tasks");
  const byId = new Map<string, PlanTask>();
  for (const t of tasks) {
    if (!t || typeof t !== "object" || typeof t.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(t.id) ||
        typeof t.title !== "string" || !t.title.trim() || byId.has(t.id)) throw new Error("Invalid or duplicate task ID/title");
    if (t.phase !== undefined && (!Number.isSafeInteger(t.phase) || t.phase < 1)) throw new Error("Invalid task phase");
    if (t.dependsOn !== undefined && (!Array.isArray(t.dependsOn) || t.dependsOn.some((d: unknown) => typeof d !== "string") || new Set(t.dependsOn).size !== t.dependsOn.length)) throw new Error("Invalid dependencies");
    if (t.role !== undefined && !["planner", "builder", "reviewer", "fixer", "custom"].includes(t.role)) throw new Error("Invalid task role");
    for (const field of ["agentId", "cli", "model"] as const) if (t[field] !== undefined && (typeof t[field] !== "string" || !t[field].trim())) throw new Error(`Invalid ${field}`);
    validateFolder(t.folder);
    byId.set(t.id, t);
  }
  for (const t of tasks) for (const id of t.dependsOn ?? []) {
    const dep = byId.get(id);
    if (!dep) throw new Error(`Unknown dependency ${id}`);
    if ((dep.phase ?? 1) > (t.phase ?? 1)) throw new Error(`Dependency ${id} is in a later phase`);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error("Cyclic task dependencies");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)!.dependsOn ?? []) visit(dep);
    visiting.delete(id); visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
}

// Deliberately small allowlist. Provider subscription logins remain on disk in
// the worker account; GitHub, API, cloud and control-plane secrets are not inherited.
export function agentEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "LANG", "LC_ALL", "TERM"]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) if (allowed.has(key.toUpperCase())) env[key] = value;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "credential.helper";
  env.GIT_CONFIG_VALUE_0 = "";
  return env;
}
