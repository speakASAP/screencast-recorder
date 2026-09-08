# GOAL-IMPACT-TASK-001: Bootstrap screencast-recorder

```yaml
id: GOAL-IMPACT-TASK-001
artifact_type: task
artifact_id: TASK-001-bootstrap-service
artifact_path: ../11_tasks/TASK-001-bootstrap-service.md
primary_goal: "Turn a live multi-hour work session into structured, synchronized source material that a later editor can cut without manual searching"
secondary_goals:
  - "Design the session model so a second machine can join without redesign"
  - "Capture activity timing without capturing keystroke content"
impact_level: critical
status: approved
```

## Goal

`BUSINESS.md`, *Problem* and *Goals*: the owner works across multiple computers
and wants to publish YouTube videos of real development work, but manually
reconstructing a 3–4 hour session loses the timing information needed to find
the useful moments. Goals 1–8 of that document define the capture outcome, and
the stated business metric is **editing time saved per published video**, not
the amount of footage recorded.

`docs/01_vision/VISION.md`, *Phase 1 outcome*: a single Ubuntu workstation
records selected sources as independent tracks and stores a verified session.

## Contribution

This task is the precondition for every later goal. Post-production cannot
reduce three hours to fifteen minutes unless the raw material already carries
per-track timing, an activity index, and a machine-readable manifest. Recording
first and adding structure later is not possible: a session cannot be
re-recorded.

Three design choices carry most of the contribution:

- **Segmentation** lets an editor discard whole intervals with `-c copy`
  instead of re-encoding, and caps crash loss at 60 seconds.
- **Separate tracks** let audio and video be recombined independently.
- **The `T0` barrier and recorded clock offset** make multi-machine alignment
  exact rather than approximate, which is what allows the MacBook to be added
  later without changing the session model.

## Success metric

- A 3–4 hour session is captured with no manual per-track intervention, and
  every selected track shares one session id and one timing origin.
- The stored session is complete enough that an editor can locate active
  intervals from `events.jsonl` and `manifest.json` alone, without opening the
  video.
- An API outage during recording costs zero footage.
- The later product metric, measurable only in phase 2: a multi-hour session is
  reduced to a substantially shorter publishable video without the operator
  manually scrubbing the raw recording.

File creation is not a success metric.

## Invariant compatibility

Preserved, with the mechanism for each:

| Invariant | Preservation mechanism |
|---|---|
| No keystroke or clipboard content | The tracker records counts and modifier names only; there is no code path that reads key symbols. |
| No MinIO root at runtime | Runtime uses a service account under a non-root user, bound to a policy scoped to one bucket. |
| No secret in Git, logs or output | All secrets live in Vault; key names only are documented. |
| No premature deletion | Local media is deleted only after S3 verification *and* operator preview; phase 1 deletes nothing automatically. |
| `speakasap-records` untouched | Enforced by storage policy, verified by a denial test, not by code convention. |
| Canonical service identity | Follow `SERVICE_IDENTITY_CONSUMER_STANDARD.md`; local role `internal:screencast-recorder:agent`. |

## Upstream and downstream links

- Upstream: [`BUSINESS.md`](../../BUSINESS.md) *Problem*, *Goals*, *Success
  metrics*; [`docs/01_vision/VISION.md`](../01_vision/VISION.md) *Phase 1
  outcome*, *Architecture boundary*
- Design: `../superpowers/specs/2026-09-06-screencast-recorder-design.md`
- Task: `../11_tasks/TASK-001-bootstrap-service.md`
- Plan: `../21_execution_plans/EP-TASK-001-bootstrap-service.md`
- Validation: `../12_validation/VAL-TASK-001-bootstrap-service.md`

## Validation method

Evidence comes from a real recording, not from a unit test alone:

1. Run a session on `alfares` capturing `HDMI-A-0` and the Jabra microphone.
2. Confirm separate segmented tracks, `events.jsonl`, and a `manifest.json`
   whose per-segment time ranges and recorded clock offset reconstruct the
   session timeline.
3. Kill the API mid-recording and confirm capture continues and reconciles.
4. Save, and confirm every object is verified present in S3 before the session
   is marked stored.
5. Confirm the scoped credential is denied on `speakasap-records` and on admin
   operations.
6. Inspect `events.jsonl` and confirm it contains no key characters.
