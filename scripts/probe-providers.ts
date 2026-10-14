import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { providerAdapters } from "../apps/server/src/providers";

const out = resolve("outputs/PR-002"); mkdirSync(out, { recursive: true });
const probes = await Promise.all(Object.values(providerAdapters).map((adapter) => adapter.probe()));
writeFileSync(resolve(out, "capabilities.json"), JSON.stringify(probes, null, 2));
console.log(JSON.stringify(probes.map((p) => ({ provider: p.provider, installed: p.installed, version: p.version, authentication: p.authentication, models: p.models.length, efforts: p.capabilities.efforts, permissions: p.capabilities.permissions, streaming: p.capabilities.streaming, error: p.error })), null, 2));
