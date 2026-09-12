# VAL-TASK-004: command acknowledgement

Status: **partially validated** — offline evidence complete, one live check
outstanding.
Date: 2026-09-12.

## What was broken

`CommandsService.nextFor` set `deliveredAt` when it handed a command out, and
the same column was the only marker distinguishing a finished command from a
pending one. An agent that died between receiving a command and acting on it
therefore never saw that command again. A pending `stop` was simply lost and
its session sat in `stopping` for ever, with the media captured and the
manifest in but Save and Discard unreachable.

The service had no spec file at all, which is why the behaviour was recorded as
a known limitation rather than caught.

## What changed

- Delivery is a **30-second lease**, not a retirement. `nextFor` offers any
  command that is unacknowledged and either never delivered or delivered longer
  ago than the lease.
- `POST /api/agents/{id}/commands/{cid}/ack` retires a command. The agent sends
  it **after** applying, so a crash mid-handling leaves the command eligible.
- The agent's applied-command set is **durable**
  (`agent/src/applied-store.ts`, `.applied-commands.json` beside the pending
  queue). This is what makes redelivery safe: the restart that causes a
  redelivery is the event that used to empty the in-memory set, so without it a
  redelivered `start` would spawn a second ffmpeg tree into one directory.
- Bounded at **3 deliveries**. Past the cap the session is failed with
  `command_unacknowledged` — but only if it is still in a state that can
  legally fail, otherwise the command is retired silently. A finished session
  cannot be failed, and pushing a failure at one would throw the transition
  guard's 400 out of the agent's poll route and take its heartbeat down.

## Evidence

### Tests

525 tests across 48 suites (API) and 249 across 22 (agent), all passing, up
from 503/46. `commands.service.ts` went from no spec to 12 tests covering:
handout counting a delivery; no redelivery inside the lease; redelivery after
it; an acknowledged command never re-offered; oldest-first ordering; ack
scoped to the agent and idempotent; the cap stopping redelivery; and an
abandoned command reported once rather than on every poll.

Agent-side: a redelivered command still refused after a simulated restart
(ids round-tripped through the store); acknowledgement ordered after the work,
not before; a duplicate acknowledged too — it exists because the first delivery
was not, and leaving it unacknowledged would walk it to the cap and fail a
healthy session; and an ack whose POST fails not failing the command, because
the work is already done.

One pre-existing test broke and was corrected rather than worked around:
`renders every audio source` read `api.post`'s *last* call, which is now the
ack. It selects the preview report by path instead.

### Migration

`1757200700000-CommandAcknowledgement`, additive, dry-run on
`scratch_alert_mig` against a table built to match the live schema, then
reverted, then dropped:

- `up()`: two rows, one delivered and one not. `UPDATE 1` — only the delivered
  row was retired (`acked=t, cnt=1`); the undelivered one stayed deliverable
  (`acked=f, cnt=0`). Index replaced.
- `down()`: schema returned to exactly the original seven columns and the
  original index name.

Two facts were read from the live database rather than assumed. The index is
named `IDX_commands_agent_undelivered`, not the `IDX_commands_agentId_*` the
first draft guessed — a wrong name would have left the stale index in place
under an `IF EXISTS` that silently matched nothing. And all 64 rows in the live
`commands` table are already delivered with none pending, so treating
pre-existing commands as acknowledged strands nothing; the alternative would
have redelivered the entire history of past sessions on the agent's next poll.

## Outstanding

The live check this change exists for, and the one thing none of the above
proves: issue a stop, restart the agent (`systemctl --user restart
screencast-agent`) before it finishes handling, and confirm the restarted agent
is handed the stop again and completes it, with the session reaching `review`
rather than staying in `stopping`.

Until that runs, the offline evidence shows the protocol is right; it does not
show the deployed pair behaving.
