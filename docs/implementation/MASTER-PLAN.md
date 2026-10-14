# ORKESTRA — MASTER IMPLEMENTATION PLAN

> User amendment, 2026-10-14: Run the Windows worker under the existing Windows account. Do not require a VM or separate account. This overrides the account/VM prerequisite below; provider-native permissions, approvals, credential filtering and workspace checks remain part of the implementation.

> User amendment, 2026-10-14: Use Antigravity CLI (`agy`) as the Google provider after Gemini CLI returned `UNSUPPORTED_CLIENT` on fresh sign-in. Integrate Antigravity as its own provider. Retain Gemini separately; its account-tier restriction does not gate the chosen Google integration.

**Project:** Custom Orkestra Multi-Agent Development Command Center
**Status:** Approved development direction
**Starting point:** https://github.com/burakdemir16/Orkestra-CLI

## PRIMARY OBJECTIVE

Build a reliable, secure, mobile-friendly system that coordinates OpenAI Codex, Anthropic Claude Code, and Google Gemini CLI.

The completed system will use:

- Existing Unraid NAS as the always-on control center.
- Existing Windows development computer as the coding worker.
- Existing Tailscale network for private connectivity.
- Samsung Galaxy S26 with an installable, mobile-first PWA.
- Existing provider logins and subscription-supported coding interfaces wherever permitted.

It must support Single, Debate, Chorus, DAG, Team, and independent Review modes.

Its default Smart Auto mode must intelligently choose collaboration strategies, models, reasoning effort, and sub-agents.

A global Caveman switch must apply to all three managed providers and their applicable sub-agents. Superpowers must be available to all three providers.

Preserve useful Orkestra functionality. Replace unsafe or unreliable internals incrementally rather than rewriting everything.

Do not build unnecessary infrastructure or redundant phone features.

---

# PHASE 1 — FORK, AUDIT, AND REPAIR ORKESTRA

## 1.1 Establish the development foundation

- Fork Orkestra into a separate repository.
- Preserve the original upstream as a Git remote.
- Create a baseline branch.
- Install dependencies and run existing build scripts.
- Verify Windows compatibility.
- Inventory the current routes, components, API contracts, execution engine, storage and tests.
- Document which existing functionality is genuinely working.
- Preserve the existing React interface and useful orchestration components.

## 1.2 Repair confirmed execution defects

Address these issues before exposing execution remotely:

1. A failed agent must never be reported as successful merely because an error message was returned as text.
2. A failed dependency must block dependent tasks unless an explicit recovery path exists.
3. Invalid dependency IDs and cyclic DAGs must fail validation.
4. Planner-generated folder paths must not escape approved workspaces.
5. Windows process cancellation must terminate the relevant process tree.
6. Agent execution must not automatically receive unnecessary GitHub credentials.
7. CLI runs must not silently modify global trusted-workspace configuration.
8. Missing approval state must never trigger automatic approval.
9. Interrupted runs must not silently re-execute potentially destructive actions.
10. Parallel agents must not unsafely modify the same shared workspace.

Add regression tests for each issue.

## 1.3 Replace unsafe execution defaults

Remove unconditional permission-bypass execution options.

Implement a restricted worker execution policy:

- Read-only investigation.
- Approved workspace writes.
- Elevated actions requiring additional authorization.
- Explicitly restricted filesystem and credential access.
- Controlled networking where practical.
- No automatic Git push or destructive system actions.

Use a lower-privilege Windows execution identity or a stronger isolated environment, such as a dedicated VM, where required. A Git worktree alone is not a security sandbox.

## 1.4 Establish durable job states

Use explicit states:

- QUEUED
- ASSIGNED
- RUNNING
- WAITING_FOR_APPROVAL
- VERIFYING
- COMPLETED_VERIFIED
- COMPLETED_UNVERIFIED
- FAILED
- CANCELED
- INTERRUPTED

Persist state transitions and audit records.

Prevent invalid state transitions.

### Exit criteria

- Orkestra builds and starts on Windows.
- Known execution defects have regression coverage.
- Invalid DAGs cannot execute.
- Failed jobs cannot become successful jobs.
- Unsafe execution flags are not required for normal operation.
- Missing approvals fail closed.
- Cancellation works reliably.

---

# PHASE 2 — BUILD RELIABLE AI PROVIDER ADAPTERS

Create one provider integration layer with separate adapters for:

- Codex.
- Claude Code.
- Gemini CLI.

Keep Google's Antigravity separate from Gemini CLI; it may be added as an independent provider later.

## 2.1 Common adapter responsibilities

Each adapter should provide:

- Provider authentication status.
- Available model information.
- Supported reasoning effort or thinking settings.
- Session creation and continuation.
- Structured execution events.
- Tool execution visibility where available.
- Token and usage reporting where available.
- Graceful cancellation.
- Timeouts and process cleanup.
- Error classification.
- Rate-limit handling.
- Supported approval mechanisms.
- Native sub-agent capability information.

Use supported structured interfaces whenever practical.

Candidates include:

- Codex App Server.
- Claude Agent SDK.
- Gemini CLI's headless structured JSON events.

Probe actual CLI versions and capabilities rather than assuming features from static documentation.

## 2.2 Unified configuration

Create a normalized agent configuration supporting:

- Provider.
- Model.
- Reasoning effort.
- Role.
- Skills.
- Permissions.
- Sub-agent settings.
- Fallback configuration.

Translate these to provider-specific settings.

Unsupported options must be visibly unavailable.

Always record the effective configuration actually used.

## 2.3 Test matrix

Test every provider for:

- Authentication.
- Simple response.
- Multi-turn conversation.
- Code editing in a disposable workspace.
- Model switching.
- Reasoning-effort switching.
- Streaming events.
- Cancellation.
- Quota errors.
- Tool errors.
- Interrupted sessions.
- Resumption, where supported.

Test supported interactive approvals separately. Do not assume all providers offer identical approval protocols.

### Exit criteria

All three providers can execute, report status, and fail safely through the common adapter interface.

No simulated model or effort controls are presented as real.

---

# PHASE 3 — UNRAID CONTROL PLANE AND WINDOWS WORKER

This phase is a priority. Do not postpone Unraid until every advanced feature is complete.

## 3.1 Unraid server

Run the Orkestra control plane in Docker.

Proposed persistent location:

`/mnt/user/appdata/orkestra/`

Responsibilities:

- Host the application API.
- Serve the web interface.
- Persist conversations.
- Persist job state.
- Store settings and project records.
- Maintain the task queue.
- Schedule DAG nodes.
- Store execution events.
- Maintain approvals and audit history.
- Track Windows worker availability.

Start with SQLite and a transactional job queue. Add Redis or another queue backend only if demonstrated reliability or scale requirements justify it.

## 3.2 Windows worker daemon

Create a dedicated worker service that:

- Starts reliably with Windows.
- Establishes an outbound authenticated connection to Unraid.
- Advertises available providers and capabilities.
- Receives authorized, typed jobs.
- Runs CLIs against approved Windows projects.
- Streams events and results.
- Handles cancellation.
- Reports health and execution status.
- Reconnects after network interruption.

Do not expose an unrestricted shell-execution API.

## 3.3 Durable job ownership

Implement:

- Unique job identifiers.
- Idempotency keys.
- Worker leases.
- Heartbeats.
- Retry policies.
- Append-only or otherwise durable execution events.
- Approval state persisted across restarts.
- Explicit interrupted-job recovery.

Do not automatically retry non-idempotent operations.

When the system cannot determine whether a previous execution caused side effects, require reconciliation or user intervention.

## 3.4 Offline behavior

Windows online:

- Run coding tasks.
- Stream results.
- Review changes.
- Execute DAGs.

Windows offline:

- Keep the NAS dashboard accessible.
- Show stored history.
- Accept new tasks into the queue.
- Mark code-dependent planning as waiting for worker context.
- Resume eligible work when Windows reconnects.

## 3.5 Tailscale

Use the existing Tailscale deployment.

Verify that the S26, Unraid host, and Windows worker have the necessary tailnet connectivity.

Use Tailscale Serve or an appropriate existing private HTTPS reverse-proxy setup for the PWA.

Do not enable public Tailscale Funnel access.

Enforce appropriate application authentication, worker authentication, origin checks, and access restrictions.

### First major milestone

From the Galaxy S26:

1. Open the Orkestra page hosted on Unraid.
2. Select a project stored on Windows.
3. Submit a harmless read-only AI task.
4. Watch the Windows worker receive it.
5. Receive a streamed answer on the phone.
6. Reopen the job history after restarting the browser.

This must work before building the sophisticated Auto coordinator.

### Exit criteria

The phone-to-NAS-to-Windows-to-NAS-to-phone workflow works over the existing Tailscale network.

The system safely handles temporary disconnections and Windows being offline.

---

# PHASE 4 — MOBILE-FIRST PWA

Extend the existing React frontend.

Keep one codebase for desktop and mobile.

## 4.1 Main navigation

Provide:

- Home.
- Chat.
- Projects.
- Runs.
- Agent management.
- Settings.

The interface should fit the Galaxy S26 naturally.

Use proper responsive layouts, safe-area handling, touch targets, and Android keyboard behavior.

## 4.2 Agent controls

Every agent card should make it easy to change:

- Model.
- Reasoning effort.
- Role.
- Enabled skills.
- Permissions.
- Automatic or manual configuration.

## 4.3 Run monitoring

Provide:

- Real-time execution status.
- Active agents and sub-agents.
- Expandable agent logs.
- DAG visualization.
- Task-detail view.
- Pause or stop controls.
- Approval requests.
- Code diffs.
- Verification results.
- Execution history.

Large logs must use virtualization or bounded rendering to avoid overwhelming the phone browser.

## 4.4 PWA

Implement:

- Installable manifest.
- Appropriate icons.
- Standalone launch mode.
- Responsive layout.
- Dark mode.
- App-safe navigation.
- Recoverable UI state.
- Reconnection indicators.

Do not cache authentication credentials or sensitive project content unnecessarily.

Do not attempt offline execution of coding agents through the PWA.

No custom voice dictation is needed.

## 4.5 Mobile feature parity

All core workflows must be accessible on mobile.

Some desktop functions may use mobile-specific views.

For instance:

- DAG: interactive graph plus a structured list.
- Diff: side-by-side on desktop, inline on mobile.
- Agent comparison: columns on desktop, tabs or swipe views on mobile.

Advanced terminal access, if offered, should require explicit authorization and separate security controls.

### Exit criteria

The PWA can be installed and used comfortably on the S26.

All core operations—including approvals, model switching, and code review—work without switching to a desktop.

---

# PHASE 5 — COLLABORATION ENGINE

Preserve and extend Orkestra's existing collaboration features.

## 5.1 Single Agent

Direct communication with one selected provider/model.

## 5.2 Debate

Support:

- Independent initial positions.
- Structured rebuttals.
- Configurable rounds.
- Optional evaluator.
- Final synthesis.
- Preserved disagreements.

## 5.3 Chorus

Execute multiple independent agents against the same request.

Add a synthesis step that compares conclusions and identifies complementary insights, uncertainty, and contradictions.

## 5.4 DAG

Create a validated dependency graph.

Implement:

- Topological scheduling.
- Dependency enforcement.
- Limited concurrency.
- Retries for eligible tasks.
- Failure propagation.
- Persistent progress.
- Safe cancellation.
- Replanning support.

Use per-task worktrees where parallel code edits require isolation.

Integrate changes through a controlled merge and verification process.

## 5.5 Team

Assign roles to agents and save reusable team templates.

Do not hardcode particular roles to particular providers.

## 5.6 Independent Review

Allow a separate model to review work without automatically modifying it.

Use real tests and acceptance criteria to evaluate results.

### Exit criteria

Every manual collaboration mode works end-to-end.

Parallel tasks cannot silently corrupt a shared workspace.

Failure propagation, approvals, and verification are reliable.

---

# PHASE 6 — CAVEMAN AND SUPERPOWERS

## 6.1 Caveman

Repository:
https://github.com/JuliusBrussee/caveman

Implement one global checkbox.

ON:

- Apply Caveman to all new Orkestra-managed Codex, Claude, and Gemini sessions.
- Apply it to supported managed sub-agents.
- Verify activation rather than merely assuming it succeeded.

OFF:

- Do not apply Caveman to new managed sessions.
- Do not leave active run-scoped hooks or instructions behind.

Do not change unrelated standalone CLI sessions.

Prefer genuine run-scoped native integration mechanisms.

If an integration cannot reliably enforce the requested global state, report the failure rather than silently ignoring the setting.

Keep machine-readable orchestration protocols and schema validation independent of human-facing compression instructions.

Do not automatically enable Caveman's optional cloud proxy, routing, or telemetry.

Benchmark actual token savings and quality.

## 6.2 Superpowers

Repository:
https://github.com/obra/superpowers

Integrate the supported skill installation mechanisms for all three providers.

Make relevant skills available for:

- Brainstorming.
- Planning.
- TDD.
- Debugging.
- Verification.
- Code review.

Avoid duplicate outer orchestration.

Orkestra owns the global DAG, resource budgets, worker scheduling, and integration.

Superpowers provides development methodology and supported bounded workflows.

Handle native sub-agent and worktree conflicts explicitly.

Display installation, capability, and active status.

### Exit criteria

The user can turn Caveman on and off once and observe the requested behavior across all three providers for new managed runs.

Superpowers skills are accessible across all three providers without causing uncontrolled delegation or workspace conflicts.

---

# PHASE 7 — SMART AUTO ORCHESTRATION

Smart Auto becomes the default collaboration mode.

## 7.1 Design principles

AI makes judgment calls.

Deterministic software enforces safety and correctness.

Do not run expensive planning loops for trivial requests.

Start with a single agent when that is sufficient.

Escalate only when additional models or collaboration are likely to improve the result.

## 7.2 Initial task classification

Perform cheap classification using request characteristics and project metadata.

Straightforward requests may route directly to one agent.

Ambiguous, complex, multi-module, research-intensive, or architecture-heavy requests may trigger AI planning.

Avoid treating arbitrary keyword matches as definitive complexity assessments.

## 7.3 AI coordinator

The coordinator must be able to recommend:

- Collaboration mode.
- Provider.
- Model.
- Reasoning effort.
- Tasks and dependencies.
- Role assignments.
- Sub-agent count.
- Verification approach.
- Fallback strategies.

Use a structured schema.

Validate all plans before execution.

## 7.4 Planning intelligence

Allow mixed workflows.

Examples:

- Research → Debate → Implementation → Review.
- Investigation → Parallel coding → Integration → Testing.
- Single agent → Escalation → Independent verification.

No requirement to always use all three providers.

## 7.5 Automatic model selection

Use:

- Actual provider capabilities.
- Task characteristics.
- Model suitability.
- Availability and rate-limit status.
- User configuration.
- Historical evaluation results.

The user can override the selection of any supported model or effort setting.

## 7.6 Smart sub-agents

The coordinator decides when specialized agents are justified.

Suggested initial limits:

- Maximum three concurrent top-level provider tasks.
- Default one level of Orkestra-managed delegation.
- Limited retries and replanning.
- Conservative resource budgets.
- Explicit user overrides for larger workloads.

These are configurable starting policies, not universal restrictions.

Provider-native sub-agent use should obey supported resource controls where possible.

Do not invent unsupported levels of sub-agent visibility or control.

## 7.7 Auto priorities

Fast:
Minimize coordination, latency, and resource use.

Balanced:
Default mode. Add agents when justified.

Thorough:
Use stronger review and additional independent reasoning for difficult work.

## 7.8 Approval progression

Initially, Auto proposes a plan for approval before consequential work.

After sufficient testing, ordinary low-risk tasks may execute automatically within the user's configured permissions.

High-impact operations still require explicit approval.

## 7.9 Replanning

Replan only for meaningful new information, such as:

- Failed verification.
- Unexpected dependencies.
- Quota exhaustion.
- Newly discovered technical problems.

Do not let the coordinator enter unlimited planning loops.

## 7.10 Improvement through evaluation

Store:

- Chosen strategy.
- Models and effort.
- Runtime.
- Observable token usage.
- Number of agents.
- Tests.
- Failures.
- User-approved results.
- Rework.

Use these records to benchmark and refine routing.

Do not claim the system has learned automatically merely because it stores history.

### Exit criteria

Auto consistently handles simple requests without needless orchestration.

Complex requests generate valid plans.

The coordinator can choose multiple providers and specialized sub-agents when warranted.

User overrides work.

Auto never bypasses security or execution limits.

---

# PHASE 8 — TESTING, OPTIMIZATION, AND FINAL DEPLOYMENT

## 8.1 Functional testing

Test:

- All providers.
- Every collaboration mode.
- Model changes.
- Effort changes.
- Sub-agent delegation.
- Caveman on/off.
- Superpowers activation.
- Approval and denial.
- Cancellation.
- Retries and failures.
- Network interruptions.
- Worker shutdown/restart.
- Server shutdown/restart.
- Offline job submission.
- Git worktree integration.

## 8.2 Security testing

Test:

- Path traversal.
- Symlink and junction escapes.
- Unauthorized API requests.
- Invalid worker messages.
- Prompt-injection attempts.
- Credential exposure.
- Escaped commands.
- Approval bypass.
- Duplicate job execution.
- Dangerous Git operations.

No public internet exposure by default.

## 8.3 Real-world project benchmark

Use a representative set of real development tasks, including the user's NES-to-Genesis work.

Examples:

- Identify a scrolling bug.
- Analyze Genesis VDP constraints.
- Repair a specific SGDK error.
- Optimize a routine.
- Build the ROM.
- Run available emulator-based tests.
- Review a code patch independently.

Compare Single, Debate, Chorus, DAG, and Auto where appropriate.

Measure time, observable usage, correctness, and regression rates.

## 8.4 Final operation

Provide:

- Unraid deployment configuration.
- Windows worker installation.
- Startup and reconnect behavior.
- Mobile PWA installation.
- Backup and recovery documentation.
- Update process.
- Diagnostic logs.
- Health monitoring.
- Emergency kill switch.

Keep dependencies minimal and updates manageable.

### Final acceptance test

From the Galaxy S26, while away from home:

1. Open the installed Orkestra PWA.
2. Choose a Windows-hosted development project.
3. Leave collaboration, models, and effort on Auto.
4. Enable Caveman.
5. Make Superpowers available.
6. Submit a substantial coding request.
7. Observe the chosen strategy and active sub-agents.
8. Review the resulting code changes and test results.
9. Approve or reject the changes.
10. Confirm that the Windows project reflects only approved integration actions.
11. Disable Caveman.
12. Submit another task and confirm the new configuration.
13. Disconnect Windows.
14. Queue another request.
15. Reconnect Windows and confirm safe execution without duplicate side effects.

The system must behave predictably throughout this test.

---

# FIRST IMPLEMENTATION WORK ORDER

Begin with the original Orkestra repository.

Do not start by redesigning the UI.

## PR-001: Baseline and execution hardening

Tasks:

1. Clone and build Orkestra.
2. Map the execution and approval paths.
3. Create regression tests for confirmed execution defects.
4. Fix failed-task propagation.
5. Add strict DAG validation.
6. Fix path containment.
7. Fix Windows process-tree termination.
8. Remove unsafe implicit approvals.
9. Stop unnecessary credential propagation.
10. Document and test the secure execution defaults.

Provide:

- Changed files.
- Test results.
- Remaining security limitations.
- Any behavior that cannot yet be made safe.
- Recommendations for PR-002.

## PR-002: Provider adapter contracts

Create the typed adapter interface and normalized event schema.

Implement and test Codex, Claude, and Gemini integrations against disposable test repositories.

## PR-003: Unraid/Windows vertical slice

Build the smallest reliable NAS API, job store, and outbound Windows worker capable of completing one read-only task from the S26 browser.

Only then expand into the remaining phases.

---

# ENGINEERING RULES

1. Preserve working upstream features whenever reasonable.
2. Prefer existing maintained libraries over unnecessary new code.
3. Do not replace a subsystem until there is a tested replacement.
4. Never sacrifice security for apparent orchestration convenience.
5. Keep provider-specific behavior behind adapters.
6. Make task failures explicit.
7. Treat Git worktrees as collaboration isolation, not security isolation.
8. Use existing Tailscale infrastructure.
9. Make mobile a first-class experience.
10. Give the user manual control over automatic decisions.
11. Keep Caveman's global toggle genuinely global for supported managed agents.
12. Keep Superpowers available across all three providers.
13. Measure performance instead of assuming more agents improve results.
14. Build features in working vertical slices.
15. Do not begin unnecessary architecture debates once a tested solution meets requirements.

**FINAL TARGET:** One intelligent command center coordinating Codex, Claude, and Gemini securely across Unraid, Windows, and Android, with maximum practical automation and minimal unnecessary complexity.
