# EP-TASK-001-bootstrap-service: Bootstrap screencast-recorder

```yaml
id: EP-TASK-001-bootstrap-service
status: draft
source_task: ../11_tasks/TASK-001-bootstrap-service.md
goal_impact:
  - ../22_goal_impact/GOAL-IMPACT-TASK-001.md
validation:
  - ../12_validation/VAL-TASK-001-bootstrap-service.md
owner: "[MISSING: plan owner]"
created: 2026-09-06
last_updated: 2026-09-06
completeness_level: skeletal
parallelization_strategy: "[MISSING: single_agent, parallel_goals or blocked]"
required_gates:
  - adoption
  - pre-coding
```

## Upstream traceability

[MISSING: link approved business, vision, system, task and goal-impact sources]

## Scope

[MISSING: define exact bootstrap implementation scope]

## Non-goals

[MISSING: define excluded behavior and integrations]

## Project invariants

[MISSING: list applicable invariants and preservation method]

## Sensitive-data handling

[MISSING: define safe handling for configuration, fixtures, logs and evidence]

## Contract validation plan

[MISSING: list API, event, persistence and integration contract validation]

## Replay and determinism plan

[MISSING: define idempotency, retry and deterministic test requirements]

## Files to inspect

[MISSING: list authoritative inputs]

## Files to create

[MISSING: list implementation, test, deployment and documentation files]

## Files to modify

[MISSING: list allowed existing files]

## Files that must not be modified

- `docs/00_constitution/CONSTITUTION.md`
- `docs/01_vision/VISION.md`
- [MISSING: list additional protected or unrelated files]

## Implementation steps

1. [MISSING: step]

## Parallel execution

| Workstream | Status | Owner role | Allowed files | Dependencies | Validation | Merge order |
| --- | --- | --- | --- | --- | --- | --- |
| Documentation and contracts | [MISSING] | [MISSING] | [MISSING] | [MISSING] | [MISSING] | [MISSING] |
| Application implementation | [MISSING] | [MISSING] | [MISSING] | Approved contracts | [MISSING] | [MISSING] |
| Deployment and integration | final integration | Integration owner | [MISSING] | Validated application | [MISSING] | last |

## Blockers

[MISSING: list owner decisions, dependencies or approvals, or state none]

## Test plan

[MISSING: define unit, contract, integration and failure-mode tests]

## Validation plan

[MISSING: map every acceptance criterion to a command and evidence path]

## Gate commands

Run from the adopting repository:

```bash
python3 ../intent-preservation-system/scripts/validate_adoption_profile.py --root . --phase planning
python3 ../intent-preservation-system/scripts/pre_coding_gate.py --root .
```

The central deployment-readiness gate is intended for repositories adopting
the complete IPS tree. Lightweight service adoption uses the adoption gate,
project tests, integration evidence and the shared deployment preflight.

## Documentation updates

[MISSING: list documents updated during implementation and validation]

## Rollback plan

[MISSING: define code, migration, manifest and integration rollback]

## Handoff

[MISSING: define expected worker evidence and final integration owner]

## Completion checklist

- [ ] Protected intent approved
- [ ] Adoption profile valid
- [ ] Integration decisions complete
- [ ] Implementation and tests complete
- [ ] Required integrations exercised
- [ ] Deployment dry run passes
- [ ] Validation report complete
