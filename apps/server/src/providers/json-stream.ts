import { StringDecoder } from "node:string_decoder";
import { ProviderFailure } from "./common";

export class JsonLineDecoder {
  private text = "";
  private decoder = new StringDecoder("utf8");
  constructor(private accept: (value: any) => void, private maxBytes = 5 * 1024 * 1024) {}
  feed(chunk: Buffer) { this.text += this.decoder.write(chunk); this.drain(false); }
  end() { this.text += this.decoder.end(); this.drain(true); }
  private drain(final: boolean) {
    if (Buffer.byteLength(this.text) > this.maxBytes) throw new ProviderFailure("protocol", "Structured event buffer exceeded limit");
    let newline: number;
    while ((newline = this.text.indexOf("\n")) >= 0) {
      const line = this.text.slice(0, newline).trim(); this.text = this.text.slice(newline + 1);
      if (line) this.parse(line);
    }
    if (final && this.text.trim()) { this.parse(this.text.trim()); this.text = ""; }
  }
  private parse(line: string) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new ProviderFailure("protocol", "Malformed provider JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderFailure("protocol", "Invalid structured provider event");
    this.accept(value);
  }
}
