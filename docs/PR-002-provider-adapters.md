# PR-002 provider adapters

Updated 2026-10-14. This change is stacked on PR-001. The user selected Antigravity CLI as the Google integration after Gemini CLI rejected fresh Google sign-in with `UNSUPPORTED_CLIENT`.

The runner and planner now share one typed provider layer. Codex uses native App Server JSON-RPC; Claude, Gemini and Antigravity use their installed structured CLI interfaces. Agent templates retain only validated model/effort selections. No permission-bypass flags, automatic trust edits, API billing fallback or separate Windows identity are introduced.

## Delivered

- Normalized requested/effective configuration, capability probes, provider events, token usage, sessions and classified failures.
- Codex model pagination and actual per-model reasoning choices; Antigravity's native model catalog. Claude/Gemini report catalog unavailable rather than supplying invented models.
- Bounded JSON frames/output, Unicode-safe decoding, startup/turn deadlines and Windows process-tree cancellation. Concurrent cleanup is idempotent.
- Native completion is mandatory. Malformed output, zero-exit structured errors, quota exhaustion, interruptions, missing results and policy drift cannot become successful jobs.
- Explicit session continuation requires adapter ownership of the same canonical workspace and permission scope. Restart never adopts or replays a session automatically.
- Codex one-shot native approval callback, default denial without a callback, scope checks and rejection of unknown control requests. Session-wide grants, network approvals and remote execution environments are denied. The current runner supplies no native approval callback; staged diff review remains its human approval path.
- Normalized events persist as `provider_event` alongside the existing stdout/tool feed. `GET /api/providers` returns fresh metadata; existing CLI status/model pickers use native catalogs.
- Windows executable resolution supports Claude's native npm shim and the installed official `agy.exe`, without an agent-controlled shell.
- Antigravity chat uses a separate disposable scratch folder per request. Its previous log-based authentication guess and transcript-file output fallback are removed.

## Installed/live evidence

| Provider | Installed version | Native interface | Live result |
| --- | --- | --- | --- |
| Codex | 0.146.0 | App Server stdio | File read with tool/events/usage; owned session resume and low-to-medium effort; model change from `gpt-5.6-sol` to `gpt-5.6-terra`; disposable file edit passed. |
| Claude Code | 2.1.116 | `stream-json` with partial events | Claude Pro login confirmed. Native execution reported quota exhaustion, with reset at 3pm America/Chicago. Successful inference/edit acceptance remains pending. |
| Antigravity CLI | 1.3.5 | NDJSON input and `stream-json` output | Existing account fetched six native models. Gemini 3.8 Flash Low read a disposable file, resumed the owned conversation and wrote a disposable file successfully. |
| Gemini CLI | 0.64.0 | Headless `stream-json` | Installed interface probed. This account's Code Assist tier returned `UNSUPPORTED_CLIENT`; the user's fresh sign-in reproduced it. Retained separately, outside the selected Google acceptance path. |

Actual catalogs are current probe results, not guarantees of inference access. Native model/effort confirmation is recorded separately: Claude/Gemini/Antigravity do not reliably echo reasoning effort, so requested effort remains unconfirmed. Live evidence is stored locally under ignored `outputs/PR-002/live-<provider>.json`; credentials and auth codes are not included.

## Permission limits

Codex exposes read-only and approved workspace writes through its native sandbox policies. Claude is restricted to `Read,Glob,Grep`, no custom settings/MCP servers or slash-command expansion. Gemini uses a native deny-by-default admin tool policy with read tools allowed; profiles with custom hooks/MCP/discovery commands are rejected. An attempted Gemini system-settings override was explicitly rejected by the CLI's ownership check and was removed.

Antigravity's current CLI allows workspace file edits; this adapter **does not advertise read-only isolation**. Code tasks must select workspace-write with staging review. Native `accept-edits` permits editing that staged workspace; it does not bypass command review. Preflight requires request-review, outside-workspace access disabled, no persistent Allow rules and account-backed model routing. Headless permission denials remain failures even if native output otherwise reports success. The live read probe also checked that global trusted-workspace settings stayed unchanged.

All providers run as the existing Windows user. Native/provider-owned account data and caches remain accessible to their clients. These controls do not establish a new OS isolation boundary. Native startup configuration and account behavior remain part of the trusted provider runtime. Automatic global trust edits and GitHub environment credentials remain excluded.

Claude/Gemini writes and a human native-tool approval UI remain unavailable until tested. Managed skills and native subagent enablement/concurrency controls are not implemented; unsupported configuration fails explicitly. Antigravity can report built-in subagent activity, but no managed concurrency limit is claimed. Existing UI effort controls still show their upstream subset; the richer capability endpoint is ready for later UI wiring.

## Verification and remaining acceptance

Run `npm run build`, `npm test`, and `npm run test:smoke` for deterministic checks. Provider fixtures cover successful streams, policy drift, malformed/disconnected output, soft permission denials, quota, session ownership, startup cancellation and process cleanup. Runner integration tests verify persisted events, stop propagation and disposable Antigravity chat cleanup.

Local Windows verification passed: production build, 88 regression tests and the HTTP smoke test. Codex passed four live cases; Antigravity passed three. Live provider cancellation/timeout probes and the complete Claude acceptance matrix remain outstanding; fixture coverage is not represented as live acceptance.

Use `npm run providers:probe` for no-inference capability discovery. `npm run test:providers:live -- codex` and `-- antigravity` create disposable folders and consume provider quota. Blocked/failed live acceptance returns nonzero. Recheck Claude after its provider quota resets, then implement and verify its approval-capable write mode. PR-002 is not a declaration that every provider's full acceptance matrix has passed.

Next work is the PR-003 Unraid SQLite queue and outbound Windows worker, preserving approval and interrupted-run semantics. NAS/Tailscale/phone deployment has not started.

Native interfaces were checked against installed help/schema and official documentation: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference), [Claude headless CLI](https://code.claude.com/docs/en/headless), [Gemini headless](https://geminicli.com/docs/cli/headless/), [Gemini policy engine](https://geminicli.com/docs/reference/policy-engine/), [Antigravity headless](https://www.antigravity.google/docs/cli/headless/) and [Antigravity installation/auth](https://www.antigravity.google/docs/cli/install/).
