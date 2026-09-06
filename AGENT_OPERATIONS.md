# Agent Operations: screencast-recorder

This repository follows the company Cross-Agent Automation Standard:

```text
/home/ssf/.ai-agent-standards/CROSS_AGENT_AUTOMATION_STANDARD.md
```

## Roles

- Readiness scanner: classifies work and blockers without implementing.
- Worker agent: implements one bounded task or workstream.
- Worker monitor: tracks handoffs and shared-file conflicts.
- Integration validator: validates completed work and separates regressions
  from recorded validation debt.

## Before work

Confirm:

- an active task and upstream traceability exist;
- an execution plan defines scope, allowed files and forbidden files;
- integration and project-invariant impacts are explicit;
- sensitive-data and contract/schema impacts are classified;
- validation commands and evidence paths are named;
- parallel ownership, dependencies, integration owner and merge order are clear.

## Parallel work

Do not assign multiple agents to the same file, schema, migration, public
contract, deployment file or status artifact without one documented integration
owner and conflict-resolution order.

Each workstream records its objective, owner role, allowed and forbidden files,
dependencies, blockers, validation evidence and handoff output.

## Validation debt

Record known out-of-scope failures in
`docs/orchestrator/VALIDATION_DEBT.md`. Validation debt never excuses a failure
that affects the active task, changed files or acceptance criteria.

## Handoff

Update `TASKS.md` and `STATE.json` before ending an incomplete work session.
Record deferred deployment explicitly.

## Project-specific operations

[MISSING: add operations derived from approved screencast-recorder requirements]
