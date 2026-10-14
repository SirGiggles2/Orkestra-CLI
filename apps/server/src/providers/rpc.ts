import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnCommand, killProcessTree } from "../process";
import { ProviderFailure } from "./common";
import { JsonLineDecoder } from "./json-stream";

export type RpcMessage = { id?: string | number; method?: string; params?: any; result?: any; error?: { message?: string; code?: number } };
export type RpcFactory = (cwd?: string) => ChildProcessWithoutNullStreams;
export class CodexRpc {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(message: RpcMessage) => void>();
  private terminal?: Error;
  private closing?: Promise<void>;
  constructor(cwd?: string, factory: RpcFactory = (dir) => spawnCommand("codex", ["app-server", "--listen", "stdio://", "-c", 'approval_policy="never"', "-c", 'sandbox_mode="read-only"', "-c", "features.multi_agent=false", "-c", "analytics.enabled=false"], { cwd: dir })) {
    this.child = factory(cwd);
    this.child.stderr.on("data", () => {}); // No credential-bearing raw startup logs in app events.
    const decoder = new JsonLineDecoder((message: RpcMessage) => {
      if (!message || typeof message !== "object") { this.fail(new ProviderFailure("protocol", "Invalid app-server message")); return; }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(Number(message.id));
        if (!pending) return;
        this.pending.delete(Number(message.id)); clearTimeout(pending.timer);
        if (message.error) pending.reject(new ProviderFailure("protocol", message.error.message ?? "App-server request failed"));
        else pending.resolve(message.result);
      } else for (const listener of this.listeners) {
        try { listener(message); } catch (error) { this.fail(error as Error); }
      }
    });
    let bytes = 0;
    this.child.stdout.on("data", (chunk: Buffer) => { try { bytes += chunk.length; if (bytes > 30 * 1024 * 1024) throw new ProviderFailure("protocol", "App-server output exceeded limit"); decoder.feed(chunk); } catch (error) { this.fail(error as Error); } });
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", () => { this.fail(new ProviderFailure("interrupted", "App-server disconnected")); });
  }
  private fail(error: Error) {
    if (this.terminal) return;
    this.terminal = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const listener of this.listeners) { try { listener({ method: "transport/error", params: { message: error.message } }); } catch { /* Preserve the first transport failure and still clean up. */ } }
    void this.close().catch(() => {});
  }
  subscribe(listener: (message: RpcMessage) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify(method: string, params: unknown = {}) { this.send({ method, params }); }
  respond(id: string | number, result: unknown) { this.send({ id, result }); }
  rejectRequest(id: string | number) { this.send({ id, error: { code: -32601, message: "Unsupported managed request" } }); }
  private send(message: unknown) {
    if (this.terminal) throw this.terminal;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request<T = any>(method: string, params: unknown = {}, timeoutMs = 15_000): Promise<T> {
    if (this.terminal) return Promise.reject(this.terminal);
    return new Promise((resolveResult, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ProviderFailure("timeout", `App-server ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    const result = await this.request("initialize", { clientInfo: { name: "orkestra", title: "Orkestra", version: "0.2.12" } });
    this.notify("initialized"); return result;
  }
  close() { return this.closing ??= killProcessTree(this.child); }
}
