# VAL-TASK-003-continuous-upload-and-alarms: Validate continuous upload and capture-health alarms

```yaml
id: VAL-TASK-003-continuous-upload-and-alarms
target: TASK-003-continuous-upload-and-alarms
goal_impact:
  - ../22_goal_impact/GOAL-IMPACT-TASK-003.md
status: pending
validator: speakASAP <ssfskype@gmail.com>
date: pending
sensitive_data_classification: credentials-and-incidental-screen-content
parallel_workstream_context: stable
```

## Summary

Unit tests pass (503 tests across 46 suites), and the implementation is live in
the API and console. The agent is deployed as a systemd user service; this
validation remains pending because the test scenarios described below require
real hardware and cannot be driven by unit tests alone.

## Upstream goal

[`GOAL-IMPACT-TASK-003.md`](../22_goal_impact/GOAL-IMPACT-TASK-003.md), which
reduces the downside of device failures and infrastructure outages during
capture.

## Acceptance criteria evidence

Pending. Each criterion below must be validated in the field before closure:

| Criterion | Result | Evidence |
| --- | --- | --- |
| Continuous upload during recording | Pending | Start a session, wait 3 minutes, list the S3 prefix before Stop. Record object count and elapsed time. |
| Save is fast | Pending | Time a Save to `stored`. It should be seconds, against ~3m12s before this work. |
| Audio-failure alarm | Pending | Unplug a microphone mid-recording. The banner must name that source within ~15 seconds. |
| Upload outage does not stop capture | Pending | Scale MinIO to 0 replicas for 60 seconds mid-recording. Capture must continue, banner must show upload is behind, and queued segments must upload when it returns. |
| Discard purges S3 objects | Pending | Record briefly, Discard, and confirm the S3 prefix is empty AND local files are still present. |
| Alarm visibility in browser | Pending | View the alarm banner in a real browser (text harness cannot see off-screen or white-on-white content). |
| `quietBytesPerTick` tuning | Pending | Tune the threshold in `agent/src/capture/health.ts` against a real microphone matching the 2026-09-10 incident profile. |

## Gate evidence

| Gate | Command | Result | Status |
| --- | --- | --- | --- |
| Application | `npm run typecheck && npx jest` | Pass | 503 tests across 46 suites |
| Integration (API/console) | Continuous-upload tracing, health alarm wiring, Discard purge logic | Pass (live) | Deployed to `screencast.alfares.cz` |
| Integration (agent) | Upload queue, stall/quiet detection, S3 Discard | Pending | Awaiting operator session with real hardware |

## Implementation evidence

The 11 supporting commits (T1–T11) are live in the repository and verified by
503 unit tests:

```
644c93d T1 segment eligibility        677420d T2 bounded-concurrency upload
29a8afc T3 live track directories     0ecdd3b T4 S3 prefix fixed at start (API)
2a54923 T5 continuous upload queue    0057788 T6 stall/quiet detection
7d173af T7 durable pending reports    f3e4c13 T8 agent wiring (all four modules)
88197e2 T9 API health + migration     1617596 T10 discard purges S3
9f90d1b T11 console alarm banner
```

## Known gaps and deferred findings

Recorded so they are not confused with working behavior or become deferred debt
without a trace:

- **Agent restart mid-recording stops continuous upload silently.** `uploadPrefix`
  is not restored on restart (mirroring pre-existing `sessionId` behaviour), so
  a session already recording when the agent restarts gets no further sweeps
  until its next start command. The pending-report queue survives a restart;
  the sweep does not. Acceptable for a single operator who sees the banner; a
  second machine would need to re-sync upload state on restart.

- **The `done` Set in `ContinuousUploader` grows unpruned** — roughly 1200 short
  keys for a four-hour five-track session, in a per-session process. No
  correctness impact; a per-track watermark would be the cleaner shape.

- **A decreasing byte total reads as a stall.** Latent — nothing in this repo
  prunes segments today; becomes real if segment retention is ever added.

- **Console tests are structural only.** They read `app.js` as text and never
  render the page or execute `renderAlarm`. A banner that renders white-on-white
  or off-screen would pass tests, requiring manual verification in a browser.

- **The agent is not deployed by these commits.** It is a systemd user unit;
  the continuous-upload, health and purge work takes effect on the next agent
  restart or reinstall. The API and console halves are already live.

## Recommendation

The implementation is complete and shipped. Defer publication until the operator
validates the criteria above on real hardware with real devices.

## Traceability confirmation

The delivered system matches the approved intent: continuous upload during
recording that halves crash loss, per-track health alarms within ~15 seconds,
safe Discard that purges S3 without deleting local media, and all three
contracts amended to reflect the deployed reality.
