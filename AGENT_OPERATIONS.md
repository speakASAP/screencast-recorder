# Agent Operations: screencast-recorder

## Before work

Confirm:

- onboarding/readiness gates are satisfied;
- an active task and upstream traceability exist;
- integration and invariant impacts are explicit;
- sensitive-data and contract/schema impacts are classified;
- validation commands and evidence paths are named.

## Project-specific operations

- Never start capture before the selected agent reports time/source readiness.
- Use a future absolute `T0` for synchronized starts.
- Never make the API the only holder of active recording state.
- Never delete local raw footage merely because an upload request succeeded;
  verify the stored objects first.
- Never log raw keyboard characters, clipboard contents or secret values.
- Graceful Stop is mandatory.

## Parallel work

Do not assign multiple agents to the same media contract, schema, deployment
file or status artifact without an integration owner and merge order.

## Validation debt

Known out-of-scope failures go in
`docs/orchestrator/VALIDATION_DEBT.md`. Validation debt never excuses failure
of the active task or acceptance criteria.

## Handoff

Update `TASKS.md` and `STATE.json` before ending incomplete work.

## Roles

| Role | Responsibility |
|---|---|
| Owner | Approves `BUSINESS.md`, the constitution and the vision; decides retention and publication; supplies approval evidence an agent must never self-certify. |
| Implementing agent | Writes code and documentation against the approved design; stops at the deployment boundary. |
| Reviewing agent | Verifies claims against live systems before they are recorded as fact; a peer's finding is not evidence on its own. |
| Operator | Runs recording sessions from the web UI and decides Save or Discard. |
| Recording agent (software) | Host-bound process that captures, segments, and uploads; authoritative for local media while a session is live. |
