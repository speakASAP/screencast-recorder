# GOAL-IMPACT-TASK-003: Continuous upload and capture-health alarms

```yaml
id: GOAL-IMPACT-TASK-003
artifact_type: task
artifact_id: TASK-003-continuous-upload-and-alarms
artifact_path: ../11_tasks/TASK-003-continuous-upload-and-alarms.md
primary_goal: "Ensure no recorded session is lost to storage outages, and surface device failures within minutes, not hours"
secondary_goals:
  - "Reduce Save time from three minutes to seconds by uploading continuously"
  - "Give the operator real-time visibility into per-track capture health"
  - "Make session recovery safe: Discard removes S3 objects but not local media"
impact_level: high
status: approved
```

## Goal

`BUSINESS.md`, *Problems* and *Goals*: the September 10 incident recorded one
microphone writing 914 KB over 21 minutes while its stereo pair wrote 31 MB
simultaneously, but this silent device failure was undetectable until review
time. The goals are to surface such failures within minutes, and to ensure that
temporary infrastructure failure (agent restart, storage outage) does not lose
bytes already captured to disk.

`SYSTEM.md` documented the original outcome: bytes reach S3 only after the
operator Save. This task amends that to reflect the deployed reality: bytes
reach S3 during `recording`, so an agent restart loses only the current segment
(up to 60 seconds), not the entire session.

## Contribution

Three design changes carry most of the contribution:

- **Continuous upload during recording** changes the failure mode from "we lose
  everything if the API goes down for hours" to "we lose the current segment if
  the agent restarts." A 60-second segment is acceptable loss; a multi-hour
  session is not.
- **Per-track health checks** detect stalled (zero bytes per tick) and quiet
  (bytes below a tuned floor) microphones and surfaces them in an operator-facing
  alarm within ~15 seconds.
- **Discard purges S3 objects** scoped to that session, making it safe to reject
  a recording without leaving orphaned bytes in the bucket.

## Success metric

- A real three-minute development session uploads to S3 continuously, with all
  segments uploaded before Stop is pressed.
- Save takes seconds (verifying objects already in S3), not three-minute-plus.
- An unplugged microphone is named in the alarm banner within ~15 seconds.
- A 60-second MinIO outage does not stop capture, and queued segments upload
  when it returns.
- Discarding a session leaves S3 clean without touching local media.
- The operator sees the alarm in a real browser.

The business metric, measurable in phase 2: a session with a failed device is
recognized and recovered quickly enough that the operator can re-run an affected
segment without losing the day's productivity.

## Invariant compatibility

Preserved, with the same mechanism for each as TASK-001:

| Invariant | Preservation mechanism |
|---|---|
| No keystroke or clipboard content | The tracker remains unchanged; alarm reports counts and modifier names only. |
| No MinIO root at runtime | Runtime uses a service account under a non-root user, bound to a policy scoped to one bucket. |
| No secret in Git, logs or output | All secrets live in Vault; key names only are documented. |
| No premature deletion | Local media is still deleted only after S3 verification *and* operator preview; phase 1 deletes nothing automatically. Discard is an explicit operator action. |
| `speakasap-records` untouched | Enforced by storage policy, verified by a denial test, not by code convention. |
| Canonical service identity | Follow `SERVICE_IDENTITY_CONSUMER_STANDARD.md`; local role `internal:screencast-recorder:agent`. |

## Upstream and downstream links

- Upstream: [`BUSINESS.md`](../../BUSINESS.md) *Problems*, *Goals*; [`docs/01_vision/VISION.md`](../01_vision/VISION.md) *Phase 1 outcome*
- Original design: `../superpowers/specs/2026-09-06-screencast-recorder-design.md` (now superseded in review section)
- New design: `../superpowers/specs/2026-09-11-continuous-upload-and-capture-alarms-design.md`
- Task: `../11_tasks/TASK-003-continuous-upload-and-alarms.md`
- Plan: `../21_execution_plans/EP-TASK-003-continuous-upload-and-alarms.md`
- Validation: `../12_validation/VAL-TASK-003-continuous-upload-and-alarms.md`

## Validation method

Evidence comes from a real recording with real hardware failure scenarios, not
from unit tests alone:

1. Start a live three-minute session and list the S3 prefix before Stop is
   pressed. Confirm objects are already there.
2. Time a Save; confirm it takes seconds, not three minutes.
3. Unplug an audio source mid-recording and confirm the alarm banner names it
   within ~15 seconds.
4. Scale MinIO to zero replicas for 60 seconds mid-recording; confirm capture
   continues and queued segments upload when it returns.
5. Record briefly, Discard, and confirm the S3 prefix is empty while local
   files remain.
6. Inspect the alarm banner in a real browser to confirm it is visible and
   readable.
7. Tune `quietBytesPerTick` in the agent against a real microphone replicating
   the incident device profile.
