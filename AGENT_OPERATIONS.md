# Agent Operations: screencast-recorder

## Before work

Confirm:

- onboarding/readiness gates are satisfied;
- an active task and upstream traceability exist;
- integration and invariant impacts are explicit;
- sensitive-data and contract/schema impacts are classified;
- validation commands and evidence paths are named.

## Capture-specific rules

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
