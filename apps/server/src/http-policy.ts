export function localOriginAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true; // Local CLI clients; loopback binding is separately enforced.
  try {
    const url = new URL(origin);
    return url.origin === origin && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && [String(port), "5173"].includes(url.port);
  } catch { return false; }
}
export function localHostAllowed(host: string | undefined, port: number): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].some((name) => host === `${name}:${port}`);
}
