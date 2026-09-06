# Repository Agent Instructions: screencast-recorder

## Required reading

Read in this order before planning or implementation:

1. `BUSINESS.md`
2. `SYSTEM.md`
3. `README.md`
4. `TASKS.md`
5. `STATE.json`
6. `ips-adoption.json`
7. `docs/00_constitution/CONSTITUTION.md`
8. `docs/01_vision/VISION.md`
9. `docs/06_architecture/INTEGRATION_CONTRACT.md`
10. The active task, goal-impact record, execution plan and validation plan

## Authority

- Git files in this repository are authoritative for project intent and behavior.
- Ecosystem authority is defined in
  `/home/ssf/Documents/Github/shared/docs/DOCUMENTATION_AUTHORITY.md`.
- Cross-agent rules are defined in
  `/home/ssf/.ai-agent-standards/CROSS_AGENT_AUTOMATION_STANDARD.md`.
- docs-RAG is a derived discovery index; verify critical facts against Git.
- While onboarding is incomplete, use the canonical workflow at
  `/home/ssf/Documents/Github/shared/.agents/skills/register-new-app/SKILL.md`
  and do not bypass its planning or ecosystem-registration gates.

## Intent Preservation System

Preserve this chain:

```text
Vision -> Goal Impact -> System -> Feature -> Task -> Execution Plan -> Coding Prompt -> Code -> Validation
```

Do not implement while required intent, scope, integration, invariant or
validation information is missing. Record unavailable facts as `[MISSING: ...]`
or `[UNKNOWN: ...]`; never invent them.

## Safety and operations

- Work in the authoritative server checkout.
- Do not print or commit secrets, tokens or raw production data.
- Use Vault and External Secrets for runtime secrets.
- Follow `AGENT_OPERATIONS.md` for parallel work, validation debt and handoff.
- Use the shared deployment runner and ecosystem deploy lock.
- Do not modify protected constitution, vision or approved business intent
  without a human-approved amendment.

## Project-specific rules

[MISSING: add rules derived from approved screencast-recorder intent and system constraints]

## Required final report

Report files changed, documents created, validation evidence, validation debt,
blockers, deviations and the next concrete action.
