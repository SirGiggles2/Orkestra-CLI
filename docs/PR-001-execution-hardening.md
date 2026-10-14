# PR-001: baseline and execution hardening

Date: 2026-10-14. Scope: the first implementation work order in [the approved master plan](implementation/MASTER-PLAN.md).

## Foundation and baseline

- Fork: https://github.com/SirGiggles2/Orkestra-CLI
- Upstream: https://github.com/burakdemir16/Orkestra-CLI
- Baseline commit: `96e06ead873b2770813683cc8e07d88b4ae725eb`.
- Local baseline branch: `baseline/upstream`; implementation branch: `pr-001-execution-hardening`.
- `upstream` retains the original repository; `origin` points to the user fork.
- Windows, Node 24.14.1, npm 11.11.0. Installed CLI help probes: Codex 0.146.0, Claude Code 2.1.116. Gemini CLI was not found in PATH.
- Unchanged upstream build passed. All 33 upstream tests passed outside the desktop filesystem sandbox. Six added behavioral regressions failed against upstream before the fixes.

## Inventory and execution paths

| Area | Current implementation and contracts |
| --- | --- |
| Web | Existing React UI in `apps/web/src/main.tsx`, styles in `styles.css`, Vite build in `dist/web`. Chat/debate, agents, projects, run feed, diff review, optional terminal/preview, GitHub controls, exports and notifications retained. No redesign. |
| API | Fastify in `index.ts`; route families: health, uploads, chat/debate/analysis/brief/plan, CLI status/login/install/logout/test, agent CRUD, API-provider configuration, runs/events/note/stop/resume/apply/discard/pending, projects, file browsing/read, Git/GitHub, terminals, previews. |
| Contracts | `packages/shared/types.ts`: agents, runs, events, plan tasks, chat requests/responses, provider status. Legacy four-state UI status retained alongside explicit `executionState`. |
| Planning/chat | `cli.ts`: provider readiness, prompt construction, headless calls, plan parsing, debate, fallback. Existing Antigravity implementation is separate from the future Gemini adapter. |
| Execution | `POST /api/runs` validates before scheduling. Runner claims the canonical project, executes linear roles or phase tasks, streams events, and releases ownership on termination. Same-project tasks are serialized. |
| Approvals | Write runs use per-phase staging. Result is committed and sealed before review; a live one-shot callback is required to apply. Apply checks the reviewed commit and clean main workspace. Missing callbacks, changed results and restart recovery never authorize integration. |
| Storage | Existing JSON Store plus encrypted API-provider/GitHub stores. State transitions now flush synchronously with audit events; active records survive history pruning. Restarted queued/running/waiting jobs become `INTERRUPTED`. SQLite/leases remain PR-003 work. |
| Tests | Existing provider-config, keyring/store, folder-picker, staging, runner approval and template tests; added scheduler/security/process/state regressions and a loopback HTTP smoke script. |

### What is verified working

Windows dependency installation, TypeScript/Vite build, startup and built React asset serving; original tests; dry-run execution and stored output; dependency gating; staging apply/discard; explicit staged review; Windows process-tree kill; server history surviving restart; rejection of invalid DAGs, unsafe paths, hostile origins and overlapping projects.

Live Codex/Claude/Gemini authentication, subscription execution, native approvals, model changes, effort changes, SSE delivery to a phone, Unraid, Tailscale and PWA installation were **not** tested. The smoke task is explicitly a dry run. Existing default agents are simulations until configured; `COMPLETED_UNVERIFIED` does not certify code correctness.

## Confirmed defects and repairs

| Required defect | Repair and regression coverage |
| --- | --- |
| Failure text treated as success | Missing/exhausted agents throw; dependent tasks never start; linear missing roles fail; structured provider errors reject even with exit code zero. |
| Failed dependency ignored | Scheduler requires every dependency in the successful output map, including prior-phase dependencies. Discarding a phase aborts dependent work. |
| Invalid/cyclic DAG | Validate unique nonempty IDs, titles, dependency types/existence, self/cycles, phase ordering, roles and folders before execution. Planner output is validated, never sanitized into a different plan. |
| Planner paths escape | Reject traversal, absolute/drive/UNC paths, Windows alternate streams and reserved names; canonical containment checks existing ancestors for junction/symlink escapes. API file output, project/file access and previews use containment checks. |
| Windows cancellation | Native/npm entrypoints run without an interpolating shell. Stop and shutdown await `taskkill /T /F`; timeouts use the same tree termination. A real parent-and-grandchild test verifies cancellation. API requests receive abort signals. |
| Credentials propagated | Child environment uses a small allowlist; GitHub/API/cloud/control-plane secrets and Node injection options are excluded. No runner GitHub token injection or credential-bearing prompt. Git credential helper is disabled for managed child calls. |
| Global workspace trust changed | Automatic trust writes removed from execution and chat. Compatibility helper throws and cannot create a settings file. |
| Missing approval auto-applied | Live control required; no implicit approve branch. Stop releases pending review as discard. Staging result changes invalidate approval. |
| Interrupted actions replayed | Disk cursor does not authorize resume. Restarted jobs retain artifacts and become interrupted; reconciliation/new submission required. Write failures never auto-retry or fall back. |
| Parallel shared writes | Serialize tasks and exclude simultaneous/nested project claims across runs in one server. Worktrees remain staging, not a security sandbox. |

## Secure execution defaults

The server is loopback-only. Non-loopback binding fails. Host and Origin checks limit browser access to the configured local server and Vite's local development origin. These checks are **not user authentication**.

Default run permission is `read-only`. No baseline commit, prompt, transcript or phase-state file is written into the selected project. Job artifacts stay in the store/staging directory. A new generated workspace directory may be created by Orkestra itself. Read-only CLI task subfolders must already exist.

`preWriteApproval: true` requests `workspace-write`, unless an explicit contradictory permission is provided (rejected). Write runs require an existing clean Git repository with HEAD. Orkestra no longer silently commits the user's dirty project to create a baseline. Preserve/commit existing changes deliberately before requesting a write run.

Managed CLI execution and write runs are disabled until an administrator provisions a restricted worker account or VM and explicitly sets `ORKESTRA_ISOLATED_WORKER=1`. **That setting is an assertion, not a verified sandbox.** Do not set it on an unrestricted personal account. The account/VM must enforce approved filesystem access and network policy, have only provider login material, and lack unrelated credentials. Provisioning and evidence of isolation are still outstanding.

| Provider | Current policy |
| --- | --- |
| Codex | Only model/effort selections survive normalization. `exec`, ignored user config, ephemeral JSON events, explicit read-only/workspace-write sandbox, denied escalation (`approval_policy="never"`), workspace network access disabled. Unknown flags fail closed. No interactive approval bridge yet. |
| Claude | Read/Glob/Grep tools only, deny unapproved tool calls, strict empty MCP config, no inherited setting sources, no skills, no persisted session. Workspace writes fail pending PR-002's approval-capable adapter. |
| Gemini | Explicitly unavailable pending version/capability/approval probes in PR-002. Never routed to `agy`. |
| Antigravity | Separate provider; managed execution unavailable until it has a restricted adapter. Global trust/bypass behavior removed. |
| API text providers | Existing text calls retained. Files can be written only to staged write runs through checked paths. Existing API-key billing behavior is retained, not replaced with subscription authentication. |
| Dry-run | Existing simulation retained for deterministic development/smoke tests; not evidence of provider execution. |

Elevated operations and arbitrary command/config templates are unsupported. Existing saved bypass templates fail visibly and must be replaced with minimal supported templates (`codex: ["exec"]`, `claude: ["-p"]`, optionally model/effort). No automatic Git push is issued by the runner.

Interactive terminal, CLI install/login and project preview execution require separate local opt-in: `ORKESTRA_ENABLE_LOCAL_TERMINAL=1`. They remain privileged local tools, not worker job types. Static project previews receive sandbox CSP and cannot call the application API from their opaque origin.

States available: `QUEUED`, `ASSIGNED`, `RUNNING`, `WAITING_FOR_APPROVAL`, `VERIFYING`, `COMPLETED_VERIFIED`, `COMPLETED_UNVERIFIED`, `FAILED`, `CANCELED`, `INTERRUPTED`. Terminal states cannot restart or become successful. The current runner completes as **unverified**; assigned/verification orchestration is reserved for subsequent vertical slices.

## Validation

Latest local result: **62 tests passed, 0 failed**; TypeScript/Vite build passed; Windows HTTP/startup/restart smoke passed. Npm and pnpm dependency audits report zero known vulnerabilities. The GitHub workflow runs the npm Windows checks on the draft branch and pull request; its remote result must be checked separately.

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd test
node scripts/smoke-hardening.mjs
npm.cmd audit
```

The desktop sandbox denies Git metadata writes and native `realpath` in its temporary directory. Git/worktree tests and the actual Windows process-tree tests were run through the approved unsandboxed test command. That is a limitation of the development test harness, not a reason to weaken production containment.

Dependency repair: compatible locked updates plus `@fastify/static` 10.1.6 fix the baseline's 11 audit findings, including a critical shell-quote advisory and static-route traversal issues. Both npm and pnpm locks are maintained. The Vite large-document-export chunk warning remains; no UI code was changed to suppress it.

## Remaining security limitations / unsafe behaviors kept disabled

1. **No provisioned OS isolation yet.** Flags, tools, path checks and worktrees cannot prevent all host-account access, junction races, inherited on-disk credentials, malicious project/Git configuration, provider hooks or unrestricted networking. Managed execution must stay disabled on the personal account. Dedicated worker provisioning and adversarial probes are required.
2. **No authenticated remote API or worker.** Local clients with machine access can call the API; browser origin checks do not authenticate local processes. Do not reverse-proxy this version through Tailscale or expose it publicly. PR-003 adds authenticated control plane/worker and approved origins.
3. **Single-process JSON store.** Atomic replacement and synchronous transitions do not provide SQLite transactions, power-loss fsync guarantees, multi-server exclusion, durable leases, idempotency or an append-only ledger. Recent output events can be lost in a crash; history retention is bounded. Restart fails closed, not automatic resumption.
4. **Process lifetime limitations.** Taskkill reliably handles the tested live parent tree, but detached or already-orphaned processes require Windows Job Objects/isolated worker supervision. Denied taskkill is reported as a failure. Abrupt host death cannot run cleanup.
5. **Staging is collaboration isolation.** External editors/processes and hostile agents can race checks; there is no cross-process project lease. Stale/dirty results are rejected when detected. Git commit/merge hooks are disabled for the staging Git runner, but external isolation is still required. Large/binary diff UI limits need approval UX work.
6. **No native approval bridge, tool-level audit, permission broker or verified code acceptance.** Claude writes, Gemini and Antigravity stay disabled rather than simulating support. No automatic retries for write operations. Restarted pending work is retained for manual reconciliation.
7. **Existing privileged features remain local.** Opted-in terminals, install commands, preview scripts and explicit GitHub routes use host privileges. Credential removal from agent processes does not secure those endpoints for remote use. API-provided base URLs and attachments need a dedicated remote threat review.

## Changed files

- `apps/server/src/runner.ts`: scheduler failure propagation, workspace ownership, approval/recovery, cancellation, policy integration, staged results.
- `security.ts`, `execution-policy.ts`, `process.ts`, `http-policy.ts`, `job-state.ts`: validation, environment, permissions, shell-free execution/tree termination, local HTTP boundary and transition rules.
- `cli.ts`: strict planner parsing, restricted headless calls, no global trust writes or shell resolver.
- `db.ts`: state validation, audit transitions, restart interruption, visible storage failures, active-record retention.
- `config.ts`, `index.ts`: loopback restriction, validation before scheduling, HTTP/terminal controls, no token injection/baseline side effects, safe preview access, awaited shutdown.
- `staging.ts`: persistent exact baseline, sealed result, stale/dirty checks, path validation and disabled Git hooks.
- `execution-hardening.test.ts`, `scripts/smoke-hardening.mjs`: regressions and Windows HTTP/startup/restart verification.
- `.github/workflows/hardening.yml`: Windows build, regression and smoke checks for the fork.
- `packages/shared/types.ts`: explicit state and run permission contracts.
- `package.json`, `package-lock.json`, `pnpm-lock.yaml`: patched dependencies.
- `.env.example`, `README.md`, this audit and `docs/implementation/`: operational defaults, approved plan and progress.

## PR-002 recommendations

Implement the common typed adapter/event contract, capability probes, effective-config recording, structured provider errors and independent approval protocols. Use Codex App Server for approvals/session events and the Claude Agent SDK for an approval-capable bounded adapter. Probe installed Gemini headless support independently of Antigravity. Test subscription auth and model/effort behavior on disposable repos; do not claim unobserved features.

Provision and verify the restricted execution identity/VM; exercise credential/network/path attacks and supervised process cancellation. Then build PR-003's SQLite job queue, authenticated outbound Windows worker, leases/idempotency/reconciliation and Unraid Docker configuration. Complete the harmless phone → NAS → Windows → phone milestone before advanced Auto, mobile redesign, Caveman or Superpowers integration.

References used with local CLI help: [Codex execution reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [Codex security](https://learn.chatgpt.com/docs/security), [Claude CLI reference](https://code.claude.com/docs/en/cli-reference). These establish controls, not proof that a host is isolated.
