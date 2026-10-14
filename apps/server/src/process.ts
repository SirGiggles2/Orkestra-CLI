import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentEnvironment } from "./security";

// Never pass agent-controlled arguments through cmd.exe/PowerShell. Resolve
// npm shims to their JS entrypoint or a native executable on Windows.
export function resolveCommand(command: string): { executable: string; prefixArgs: string[] } {
  if (process.platform !== "win32") return { executable: command, prefixArgs: [] };
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(";");
  dirs.push(join(process.env.APPDATA ?? "", "npm"));
  const candidates = command.includes("/") || command.includes("\\") ? [resolve(command)] : dirs.flatMap((dir) => [join(dir, `${command}.exe`), join(dir, `${command}.cmd`)]);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (candidate.toLowerCase().endsWith(".exe")) return { executable: candidate, prefixArgs: [] };
    if (candidate.toLowerCase().endsWith(".cmd")) {
      const shim = readFileSync(candidate, "utf8");
      const match = shim.match(/%dp0%\\([^"\r\n]+\.(?:js|mjs|cjs))/i);
      if (match) {
        const script = resolve(dirname(candidate), match[1]);
        if (existsSync(script)) return { executable: process.execPath, prefixArgs: [script] };
      }
      throw new Error(`Unsupported shell shim: ${command}. Install a native executable or supported npm CLI.`);
    }
  }
  throw new Error(`Executable not found: ${command}`);
}

export function spawnCommand(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  const resolved = resolveCommand(command);
  return spawn(resolved.executable, [...resolved.prefixArgs, ...args], {
    ...options, env: options.env ?? agentEnvironment(), shell: false,
    windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
  });
}

export function structuredFailure(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event && (event.type === "turn.failed" || event.type === "error" || event.is_error === true || event.type === "result" && String(event.subtype).startsWith("error"))) return event.error?.message || event.message || "Provider reported a structured execution error";
    } catch { /* Text output is not a structured event. */ }
  }
}

export async function killProcessTree(child?: ChildProcess): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (process.platform === "win32") {
    await new Promise<void>((resolveKill, reject) => {
      execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error) => {
        if (error && child.exitCode === null && child.signalCode === null) reject(new Error(`Process tree cancellation failed for PID ${pid}`));
        else resolveKill();
      });
    });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

export function runCommand(command: string, args: string[], input: string, timeoutMs: number, cwd?: string): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawnCommand(command, args, { cwd });
    let output = "", timedOut = false, overflow = false;
    const timer = setTimeout(() => { timedOut = true; void killProcessTree(child).catch(reject); }, timeoutMs);
    const collect = (chunk: Buffer) => {
      if (overflow) return;
      output += chunk.toString();
      if (Buffer.byteLength(output) > 5 * 1024 * 1024) { overflow = true; void killProcessTree(child).catch(reject); }
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${command} timed out; process tree terminated`));
      else if (overflow) reject(new Error("CLI output limit exceeded"));
      else if (code !== 0) reject(new Error(output.trim() || `${command} exited with code ${code}`));
      else if (structuredFailure(output)) reject(new Error(structuredFailure(output)));
      else resolveResult(output.trim());
    });
    child.stdin.on("error", (error) => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") reject(error); });
    child.stdin.end(input || undefined);
  });
}
