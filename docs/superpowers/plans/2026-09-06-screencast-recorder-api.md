# Screencast Recorder — API Service & Operator UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the NestJS control plane on port 3391 — session state machine, agent registry, MinIO verification, `GET /health` — and the four-screen operator web UI that drives a recording from Start to a verified stored session.

**Architecture:** NestJS 10 + TypeORM against PostgreSQL `screencast`, following the `cv-tuning` reference layout (`src/<domain>/` modules, `main.ts` importing `reflect-metadata` first). The API is a controller and a bookkeeper: it never touches media bytes. Agents upload to MinIO directly; the API verifies objects exist and records state. The UI is server-rendered HTML plus vanilla JS — no SPA framework, because four screens polling one endpoint do not justify a build pipeline.

**Tech Stack:** NestJS 10, TypeORM 0.3, `pg`, `class-validator`, `@aws-sdk/client-s3`, Jest.

**Spec:** `docs/superpowers/specs/2026-09-06-screencast-recorder-design.md`
**Contract:** `docs/06_architecture/AGENT_API_CONTRACT.md`

## Global Constraints

- Port **3391**, namespace **`statex-apps`**, domain **`screencast.alfares.cz`**.
- `import 'reflect-metadata';` must be the first line of `main.ts`. Node 22+ with TypeORM decorators fails obscurely without it.
- Never exit 0 on a failed boot — a silently dead service looks healthy to the deploy queue.
- Every machine-accessible route declares `internal:screencast-recorder:agent` explicitly. An undecorated route is denied **and error-logged**. Classify by effect, not HTTP verb: a POST that only reads needs a read role.
- Operator routes require `app:screencast-recorder:user`. Never mix the two lanes.
- Secrets come from the mounted Secret only. Never read Vault from application code, never log a credential, never put one in an error response.
- The API must never stream, proxy, or buffer media. Agents talk to MinIO directly.
- `active_window` from progress reports is display-only: never persisted, never logged.
- A session becomes `stored` only after object-existence verification, never on an upload command's exit status.
- Phase 1 deletes nothing automatically.
- All 13 secret keys are already in the Secret `screencast-recorder-secret`; the deployment consumes them via `secretKeyRef`.

---

### Task 1: Project skeleton that boots and answers /health

**Files:**
- Create: `package.json`, `tsconfig.json`, `nest-cli.json`, `jest.config.js`, `Dockerfile`, `.dockerignore`
- Create: `src/main.ts`, `src/app.module.ts`
- Create: `src/health/health.controller.ts`, `src/health/health.module.ts`
- Test: `src/health/health.controller.spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a bootable NestJS app on `PORT` (default 3391) with `GET /health` returning `{ status: 'ok', service: 'screencast-recorder' }`

- [ ] **Step 1: Write the failing test**

```typescript
// src/health/health.controller.spec.ts
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports ok with the service name', () => {
    expect(new HealthController().check()).toEqual({
      status: 'ok',
      service: 'screencast-recorder',
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/health --no-coverage`
Expected: FAIL — cannot find module `./health.controller`.

- [ ] **Step 3: Write the minimum to pass**

```typescript
// src/health/health.controller.ts
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string; service: string } {
    return { status: 'ok', service: 'screencast-recorder' };
  }
}
```

```typescript
// src/health/health.module.ts
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

@Module({ controllers: [HealthController] })
export class HealthModule {}
```

```typescript
// src/main.ts
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  const port = Number(process.env.PORT ?? 3391);
  await app.listen(port, '0.0.0.0');
}

bootstrap().catch((error) => {
  // Never exit 0 on a failed boot: a silently dead service looks healthy to the queue.
  console.error('screencast-recorder failed to start', error);
  process.exit(1);
});
```

```typescript
// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), HealthModule],
})
export class AppModule {}
```

Mirror `cv-tuning/package.json` for dependencies and scripts (`build`, `start`, `start:dev`, `start:prod`, `typecheck`, `test:unit`, `test`).

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npm run typecheck && npx jest --no-coverage`
Expected: both PASS.

- [ ] **Step 5: Prove it actually boots**

```bash
PORT=3391 timeout 15 npm run start:prod &
sleep 8 && curl -s localhost:3391/health
```

Expected: `{"status":"ok","service":"screencast-recorder"}`. A passing unit test is not evidence that the app boots.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: bootable NestJS skeleton with /health on 3391"
```

---

### Task 2: Entities and the initial migration

**Files:**
- Create: `src/database/database.module.ts`, `src/database/data-source.ts`
- Create: `src/sessions/entities/agent.entity.ts`, `session.entity.ts`, `track.entity.ts`
- Create: `src/database/migrations/1757200000000-InitialSchema.ts`
- Test: `src/sessions/entities/session.entity.spec.ts`

**Interfaces:**
- Consumes: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
- Produces: `Agent`, `Session`, `Track` entities; `SessionState` and `TrackKind` enums; a migration creating all three tables

- [ ] **Step 1: Write the failing test**

```typescript
// src/sessions/entities/session.entity.spec.ts
import { SessionState, isLegalTransition } from './session.entity';

describe('session state machine', () => {
  it('allows the happy path', () => {
    expect(isLegalTransition(SessionState.Preparing, SessionState.Recording)).toBe(true);
    expect(isLegalTransition(SessionState.Review, SessionState.Uploading)).toBe(true);
    expect(isLegalTransition(SessionState.Uploading, SessionState.Stored)).toBe(true);
  });

  it('refuses to skip the review gate', () => {
    // Nothing may reach S3 without the operator's explicit Save.
    expect(isLegalTransition(SessionState.Recording, SessionState.Uploading)).toBe(false);
    expect(isLegalTransition(SessionState.Stopping, SessionState.Stored)).toBe(false);
  });

  it('treats stored and discarded as terminal', () => {
    expect(isLegalTransition(SessionState.Stored, SessionState.Recording)).toBe(false);
    expect(isLegalTransition(SessionState.Discarded, SessionState.Uploading)).toBe(false);
  });

  it('allows failure from any live state', () => {
    expect(isLegalTransition(SessionState.Recording, SessionState.Failed)).toBe(true);
    expect(isLegalTransition(SessionState.Preparing, SessionState.Failed)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/sessions/entities --no-coverage`
Expected: FAIL — cannot find module `./session.entity`.

- [ ] **Step 3: Write the entities**

```typescript
// src/sessions/entities/session.entity.ts
import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Track } from './track.entity';

export enum SessionState {
  Preparing = 'preparing',
  Recording = 'recording',
  Stopping = 'stopping',
  Review = 'review',
  Uploading = 'uploading',
  Stored = 'stored',
  Discarded = 'discarded',
  Failed = 'failed',
}

// Explicit rather than inferred: the review gate is a product requirement, not
// an incidental ordering. Nothing reaches S3 without an operator decision.
const LEGAL: Record<SessionState, SessionState[]> = {
  [SessionState.Preparing]: [SessionState.Recording, SessionState.Failed, SessionState.Discarded],
  [SessionState.Recording]: [SessionState.Stopping, SessionState.Failed],
  [SessionState.Stopping]: [SessionState.Review, SessionState.Failed],
  [SessionState.Review]: [SessionState.Uploading, SessionState.Discarded],
  [SessionState.Uploading]: [SessionState.Stored, SessionState.Failed],
  [SessionState.Stored]: [],
  [SessionState.Discarded]: [],
  [SessionState.Failed]: [],
};

export function isLegalTransition(from: SessionState, to: SessionState): boolean {
  return LEGAL[from].includes(to);
}

@Entity('sessions')
export class Session {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'text' }) title!: string;
  @Column({ type: 'text', default: SessionState.Preparing }) state!: SessionState;
  @Column({ type: 'timestamptz', nullable: true }) t0!: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) startedAt!: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) endedAt!: Date | null;
  @Column({ type: 'integer', nullable: true }) clockOffsetMs!: number | null;
  @Column({ type: 'text', nullable: true }) s3Prefix!: string | null;
  @Column({ type: 'text', default: 'retain-until-published' }) retentionPolicy!: string;
  @Column({ type: 'text', nullable: true }) failureReason!: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt!: Date;
  @OneToMany(() => Track, (t) => t.session) tracks!: Track[];
}
```

```typescript
// src/sessions/entities/agent.entity.ts
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('agents')
@Index(['hostname', 'machineId'], { unique: true })
export class Agent {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'text' }) hostname!: string;
  @Column({ type: 'text' }) machineId!: string;
  @Column({ type: 'text' }) platform!: string;
  @Column({ type: 'text', nullable: true }) agentVersion!: string | null;
  // Reported by the agent at every startup; hardware changes between runs.
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) capabilities!: Record<string, unknown>;
  @Column({ type: 'timestamptz', nullable: true }) lastSeenAt!: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) enrolledAt!: Date;
}
```

```typescript
// src/sessions/entities/track.entity.ts
import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Session } from './session.entity';

export enum TrackKind {
  Screen = 'screen',
  Audio = 'audio',
  Webcam = 'webcam',
  Metadata = 'metadata',
}

@Entity('tracks')
export class Track {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @ManyToOne(() => Session, (s) => s.tracks, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session!: Session;
  @Column({ type: 'uuid' }) sessionId!: string;
  @Column({ type: 'uuid' }) agentId!: string;
  @Column({ type: 'text' }) kind!: TrackKind;
  @Column({ type: 'text' }) sourceRef!: string;
  @Column({ type: 'text', nullable: true }) codec!: string | null;
  @Column({ type: 'integer', nullable: true }) fps!: number | null;
  @Column({ type: 'integer', default: 0 }) segmentCount!: number;
  @Column({ type: 'bigint', default: 0 }) bytes!: string;
  @Column({ type: 'boolean', default: false }) degraded!: boolean;
  @Column({ type: 'text', default: 'pending' }) uploadState!: string;
}
```

Write the migration by hand to match. Do **not** use `synchronize: true`, and never run `prisma migrate dev`-style auto-generation against a live database.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npx jest src/sessions --no-coverage`
Expected: PASS.

- [ ] **Step 5: Apply the migration against the real database**

```bash
npm run migration:run
```

Then verify the tables exist and are owned correctly:

```bash
kubectl exec -n statex-apps deploy/db-server-postgres -- \
  psql -U dbadmin -d screencast -tAc \
  "select tablename, tableowner from pg_tables where schemaname='public' order by 1;"
```

Expected: `agents`, `sessions`, `tracks`, each owned by `screencast_app`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: agent, session and track entities with initial migration"
```

---

### Task 3: Agent authentication guard

**Files:**
- Create: `src/auth/agent-role.guard.ts`, `src/auth/agent-roles.decorator.ts`, `src/auth/auth.module.ts`
- Test: `src/auth/agent-role.guard.spec.ts`

**Interfaces:**
- Consumes: `AUTH_SERVICE_URL`
- Produces: `@AgentRoute()` decorator and `AgentRoleGuard`, which rejects any request whose token lacks `internal:screencast-recorder:agent`, and rejects **undecorated** routes outright

- [ ] **Step 1: Write the failing test**

```typescript
// src/auth/agent-role.guard.spec.ts
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AgentRoleGuard } from './agent-role.guard';

const ctx = (headers: Record<string, string>): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  }) as unknown as ExecutionContext;

describe('AgentRoleGuard', () => {
  const validator = { validate: jest.fn() };
  const logger = { error: jest.fn() };

  it('denies an undecorated route even with a valid token', async () => {
    // A role claim that is not enforced is not a boundary. An undecorated
    // machine route is a bug, so it fails closed and is logged.
    const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;
    const guard = new AgentRoleGuard(reflector, validator as never, logger as never);
    await expect(guard.canActivate(ctx({ authorization: 'Bearer good' }))).rejects.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });

  it('denies a token that lacks the agent role', async () => {
    const reflector = { getAllAndOverride: () => true } as unknown as Reflector;
    validator.validate.mockResolvedValue({ roles: ['internal:other-service:admin'] });
    const guard = new AgentRoleGuard(reflector, validator as never, logger as never);
    await expect(guard.canActivate(ctx({ authorization: 'Bearer wrong' }))).rejects.toThrow();
  });

  it('allows the correct pair role', async () => {
    const reflector = { getAllAndOverride: () => true } as unknown as Reflector;
    validator.validate.mockResolvedValue({ roles: ['internal:screencast-recorder:agent'] });
    const guard = new AgentRoleGuard(reflector, validator as never, logger as never);
    await expect(guard.canActivate(ctx({ authorization: 'Bearer good' }))).resolves.toBe(true);
  });

  it('denies a missing Authorization header', async () => {
    const reflector = { getAllAndOverride: () => true } as unknown as Reflector;
    const guard = new AgentRoleGuard(reflector, validator as never, logger as never);
    await expect(guard.canActivate(ctx({}))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/auth --no-coverage`
Expected: FAIL — cannot find module `./agent-role.guard`.

- [ ] **Step 3: Implement the guard**

```typescript
// src/auth/agent-roles.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const AGENT_ROUTE = 'agent_route';
/** Marks a route as machine-accessible by the recording agent. */
export const AgentRoute = () => SetMetadata(AGENT_ROUTE, true);
```

```typescript
// src/auth/agent-role.guard.ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AGENT_ROUTE } from './agent-roles.decorator';
import { TokenValidator } from './token-validator';

const REQUIRED_ROLE = 'internal:screencast-recorder:agent';

@Injectable()
export class AgentRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly validator: TokenValidator,
    private readonly logger: Logger = new Logger(AgentRoleGuard.name),
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const declared = this.reflector.getAllAndOverride<boolean>(AGENT_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!declared) {
      // Fail closed. An undecorated machine route is a defect, not a default-open case.
      this.logger.error(`Undecorated machine-accessible route denied: ${context.getClass().name}`);
      throw new ForbiddenException('Route declares no service role');
    }

    const header = context.switchToHttp().getRequest().headers?.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');

    const claims = await this.validator.validate(header.slice(7));
    if (!claims?.roles?.includes(REQUIRED_ROLE)) {
      throw new ForbiddenException('Token lacks the required service role');
    }
    return true;
  }
}
```

`TokenValidator` posts to `${AUTH_SERVICE_URL}/auth/validate` and returns the claims. It never logs the token.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npx jest src/auth --no-coverage`
Expected: all four PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: agent role guard that fails closed on undecorated routes"
```

---

### Task 4: Agent registry — enrollment and capability reporting

**Files:**
- Create: `src/agents/agents.controller.ts`, `agents.service.ts`, `agents.module.ts`
- Create: `src/agents/dto/enroll.dto.ts`, `dto/capabilities.dto.ts`
- Test: `src/agents/agents.service.spec.ts`

**Interfaces:**
- Consumes: `Agent` entity (Task 2), `@AgentRoute()` (Task 3)
- Produces: `POST /api/agents/enroll` → `{ agent_id, poll_interval_seconds }`; `POST /api/agents/:id/capabilities` → `{ accepted: true }`; `AgentsService.listActive(): Promise<Agent[]>`

- [ ] **Step 1: Write the failing test**

```typescript
// src/agents/agents.service.spec.ts
import { AgentsService } from './agents.service';

describe('AgentsService', () => {
  const repo = { findOne: jest.fn(), save: jest.fn(), create: jest.fn((x) => x) };
  const service = new AgentsService(repo as never);

  beforeEach(() => jest.clearAllMocks());

  it('is idempotent on hostname + machineId', async () => {
    // Re-enrolment after an agent restart must not create a duplicate.
    repo.findOne.mockResolvedValue({ id: 'existing-uuid', hostname: 'alfares' });
    const result = await service.enroll({
      hostname: 'alfares', machine_id: 'abc', platform: 'linux', agent_version: '0.1.0',
    });
    expect(result.agent_id).toBe('existing-uuid');
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('replaces capabilities wholesale rather than merging', async () => {
    // A camera unplugged between runs must disappear, not linger from an old report.
    repo.findOne.mockResolvedValue({ id: 'a', capabilities: { cameras: [{ id: '/dev/video0' }] } });
    await service.reportCapabilities('a', { cameras: [], displays: [], audio_inputs: [] } as never);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: expect.objectContaining({ cameras: [] }) }),
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/agents --no-coverage`
Expected: FAIL — cannot find module `./agents.service`.

- [ ] **Step 3: Implement**

`enroll` looks up by `hostname` + `machineId` and returns the existing id when found, otherwise creates one. `reportCapabilities` **assigns** the new object rather than spreading into the old one, and stamps `lastSeenAt`. Both controller routes carry `@AgentRoute()`.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npx jest src/agents --no-coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: agent enrolment and capability reporting"
```

---

### Task 5: Session lifecycle and the readiness barrier

**Files:**
- Create: `src/sessions/sessions.controller.ts`, `sessions.service.ts`, `sessions.module.ts`
- Create: `src/sessions/commands.service.ts`
- Create: `src/sessions/dto/create-session.dto.ts`, `dto/status.dto.ts`, `dto/progress.dto.ts`
- Test: `src/sessions/sessions.service.spec.ts`, `src/sessions/commands.service.spec.ts`

**Interfaces:**
- Consumes: `Session`, `Track`, `isLegalTransition` (Task 2); `AgentsService` (Task 4)
- Produces: `SessionsService.create/reportStatus/reportProgress/stop/save/discard`; `CommandsService.nextFor(agentId)`; routes `POST /api/sessions`, `GET /api/agents/:id/commands`, `POST /api/sessions/:id/status`, `POST /api/sessions/:id/progress`

- [ ] **Step 1: Write the failing test**

```typescript
// src/sessions/sessions.service.spec.ts
import { SessionState } from './entities/session.entity';
import { SessionsService } from './sessions.service';

describe('the readiness barrier', () => {
  it('does not issue start until every agent reports ready', async () => {
    const svc = makeService({ agents: ['a', 'b'] });
    await svc.reportStatus('s1', { agent_id: 'a', state: 'ready' } as never);
    expect(await svc.startIssued('s1')).toBe(false);   // still waiting on b
    await svc.reportStatus('s1', { agent_id: 'b', state: 'ready' } as never);
    expect(await svc.startIssued('s1')).toBe(true);
  });

  it('issues start to nobody when one agent fails', async () => {
    const svc = makeService({ agents: ['a', 'b'] });
    await svc.reportStatus('s1', { agent_id: 'a', state: 'ready' } as never);
    await svc.reportStatus('s1', {
      agent_id: 'b', state: 'failed', reason: 'clock_unsynchronised',
    } as never);
    expect(await svc.startIssued('s1')).toBe(false);
    expect(await svc.stateOf('s1')).toBe(SessionState.Failed);
  });

  it('sets t0 in the future, not now', async () => {
    const svc = makeService({ agents: ['a'] });
    const before = Date.now();
    await svc.reportStatus('s1', { agent_id: 'a', state: 'ready' } as never);
    const t0 = (await svc.t0Of('s1'))!.getTime();
    // Agents schedule against t0; it must leave room for the command to arrive.
    expect(t0).toBeGreaterThan(before + 1000);
  });

  it('refuses an illegal transition', async () => {
    const svc = makeService({ agents: ['a'], state: SessionState.Recording });
    // Recording -> Uploading would skip the operator's Save decision.
    await expect(svc.save('s1')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/sessions/sessions.service --no-coverage`
Expected: FAIL — cannot find module `./sessions.service`.

- [ ] **Step 3: Implement**

`create` writes the session and its tracks, then queues one `prepare` command per selected agent. `reportStatus` records per-agent readiness; when **all** are ready it computes `t0 = now + START_BARRIER_LEAD_SECONDS` and queues `start` for each; when any fails it queues nothing and moves the session to `failed` with the reason. Every state change goes through `isLegalTransition` and throws on a violation.

`CommandsService.nextFor` pops the oldest undelivered command for an agent, or resolves `null` after the long-poll window. Commands are stored with their `command_id` so redelivery is detectable.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npx jest src/sessions --no-coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: session lifecycle with an all-agents-ready start barrier"
```

---

### Task 6: MinIO verification and the storage service

**Files:**
- Create: `src/storage/storage.service.ts`, `storage.module.ts`
- Test: `src/storage/storage.service.spec.ts`

**Interfaces:**
- Consumes: `MINIO_ENDPOINT_URL`, `MINIO_BUCKET`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`
- Produces: `StorageService.verifySession(prefix, expectedObjects): Promise<{ verified: boolean; missing: string[] }>`

- [ ] **Step 1: Write the failing test**

```typescript
// src/storage/storage.service.spec.ts
import { StorageService } from './storage.service';

describe('StorageService.verifySession', () => {
  it('reports every missing object rather than the first', async () => {
    // The operator needs the whole gap, not a one-at-a-time hunt.
    const s3 = { send: jest.fn() };
    s3.send
      .mockResolvedValueOnce({ Contents: [{ Key: 'p/a', Size: 10 }] });
    const svc = new StorageService(s3 as never, 'bucket');
    const result = await svc.verifySession('p', ['p/a', 'p/b', 'p/c']);
    expect(result.verified).toBe(false);
    expect(result.missing).toEqual(['p/b', 'p/c']);
  });

  it('treats a zero-byte object as missing', async () => {
    // A truncated upload leaves a key with no bytes; presence alone is not proof.
    const s3 = { send: jest.fn().mockResolvedValue({ Contents: [{ Key: 'p/a', Size: 0 }] }) };
    const svc = new StorageService(s3 as never, 'bucket');
    const result = await svc.verifySession('p', ['p/a']);
    expect(result.verified).toBe(false);
  });

  it('verifies when every object is present and non-empty', async () => {
    const s3 = {
      send: jest.fn().mockResolvedValue({
        Contents: [{ Key: 'p/a', Size: 10 }, { Key: 'p/b', Size: 20 }],
      }),
    };
    const svc = new StorageService(s3 as never, 'bucket');
    expect((await svc.verifySession('p', ['p/a', 'p/b'])).verified).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/storage --no-coverage`
Expected: FAIL — cannot find module `./storage.service`.

- [ ] **Step 3: Implement**

Use `ListObjectsV2Command` paginated over the prefix, build a `Map<key, size>`, and return every expected key that is absent or zero-length. The service never uploads and never deletes; it only reads. That keeps the API's storage credential usage to `ListBucket`.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npx jest src/storage --no-coverage`
Expected: PASS.

- [ ] **Step 5: Prove it against the real bucket**

```bash
npx ts-node -e "
import { StorageService } from './src/storage/storage.service';
// list the real, empty screencast-sessions bucket; expect verified=false, missing=['probe']
"
```

Expected: it connects with the scoped credential and reports the object missing rather than throwing an auth error.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: MinIO object verification for session storage"
```

---

### Task 7: Manifest ingestion and upload completion

**Files:**
- Create: `src/sessions/manifest.service.ts`
- Modify: `src/sessions/sessions.controller.ts`
- Test: `src/sessions/manifest.service.spec.ts`

**Interfaces:**
- Consumes: `StorageService.verifySession` (Task 6)
- Produces: `POST /api/sessions/:id/manifest`, `POST /api/sessions/:id/upload-complete`; a session reaches `stored` only when verification passes

- [ ] **Step 1: Write the failing test**

```typescript
// src/sessions/manifest.service.spec.ts
import { SessionState } from './entities/session.entity';
import { ManifestService } from './manifest.service';

describe('upload completion', () => {
  it('refuses to mark stored when verification finds a gap', async () => {
    // The agent claiming success is not evidence; readback is.
    const storage = { verifySession: jest.fn().mockResolvedValue({ verified: false, missing: ['p/seg-00003.mp4'] }) };
    const svc = makeService(storage);
    await expect(svc.completeUpload('s1', { verified: true, objects: 4 } as never)).rejects.toThrow();
    expect(await svc.stateOf('s1')).not.toBe(SessionState.Stored);
  });

  it('marks stored when every object reads back', async () => {
    const storage = { verifySession: jest.fn().mockResolvedValue({ verified: true, missing: [] }) };
    const svc = makeService(storage);
    await svc.completeUpload('s1', { verified: true, objects: 4 } as never);
    expect(await svc.stateOf('s1')).toBe(SessionState.Stored);
  });

  it('derives expected keys from the manifest, not from the agent claim', async () => {
    // Otherwise a buggy agent that under-reports its own segments verifies clean.
    const storage = { verifySession: jest.fn().mockResolvedValue({ verified: true, missing: [] }) };
    const svc = makeService(storage);
    await svc.ingestManifest('s1', manifestWithSegments(3));
    await svc.completeUpload('s1', { verified: true, objects: 1 } as never);
    expect(storage.verifySession).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([expect.stringContaining('seg-00002')]),
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/sessions/manifest --no-coverage`
Expected: FAIL — cannot find module `./manifest.service`.

- [ ] **Step 3: Implement**

`ingestManifest` stores the manifest and updates each track's segment count and byte total. `completeUpload` builds the expected key list **from the stored manifest**, calls `verifySession`, and only then transitions to `stored`. A verification gap throws and leaves the session in `uploading` with the missing keys recorded.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npx jest src/sessions --no-coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: manifest ingestion and verified upload completion"
```

---

### Task 8: Operator web UI

**Files:**
- Create: `src/ui/ui.controller.ts`, `ui.module.ts`
- Create: `public/index.html`, `public/app.js`, `public/style.css`
- Test: `src/ui/ui.controller.spec.ts`

**Interfaces:**
- Consumes: every service above, through `GET /api/sessions` and `GET /api/agents`
- Produces: the four screens — New session, Recording, Review, Sessions

- [ ] **Step 1: Write the failing test**

```typescript
// src/ui/ui.controller.spec.ts
import { UiController } from './ui.controller';

describe('UiController', () => {
  it('builds the source list from reported capabilities, never from constants', async () => {
    // A hardcoded display list is wrong on the next machine and wrong after a
    // monitor is unplugged on this one.
    const agents = { listActive: jest.fn().mockResolvedValue([
      { id: 'a', hostname: 'alfares', capabilities: {
        displays: [{ id: 'HDMI-A-0', width: 3840, height: 2160 }],
        audio_inputs: [{ id: 'jabra', label: 'Jabra Link 390' }],
        cameras: [],
      } },
    ]) };
    const view = await new UiController(agents as never, {} as never).newSession();
    expect(view.agents[0].sources.map((s: { id: string }) => s.id))
      .toEqual(['HDMI-A-0', 'jabra']);
  });

  it('marks an absent camera unavailable rather than omitting or erroring', async () => {
    const agents = { listActive: jest.fn().mockResolvedValue([
      { id: 'a', hostname: 'alfares', capabilities: { displays: [], audio_inputs: [], cameras: [] } },
    ]) };
    const view = await new UiController(agents as never, {} as never).newSession();
    const webcam = view.agents[0].unavailable.find((u: { kind: string }) => u.kind === 'webcam');
    expect(webcam?.reason).toBe('no camera detected');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/ui --no-coverage`
Expected: FAIL — cannot find module `./ui.controller`.

- [ ] **Step 3: Implement the four screens**

**New session** — one block per online agent, checkboxes built from `capabilities`; a kind with no devices renders as a disabled row with a reason. Quality preset, title, free-disk estimate and the implied maximum recording duration. Start.

**Recording** — polls `GET /api/sessions/:id` every 2s: elapsed time, per-track segments and bytes, free disk, the `active_window` readout, and any degraded track. Stop.

**Review** — duration, tracks, total size, and two buttons: Save to S3, Discard. This screen is the only path to upload.

**Sessions** — stored sessions with size and S3 prefix.

Plain HTML and `fetch`; no framework. Show state changes as text, not only colour.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npx jest --no-coverage`
Expected: the whole suite PASSes.

- [ ] **Step 5: Look at it**

```bash
PORT=3391 npm run start:prod &
sleep 8 && curl -s localhost:3391/ | head -40
```

Expected: the New session screen renders, listing `alfares` with `HDMI-A-0` and the Jabra input, and webcam shown unavailable.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: operator web UI for session control"
```

---

### Task 9: Deployment manifests and first rollout

**Files:**
- Modify: `k8s/deployment.yaml`, `k8s/service.yaml`, `k8s/ingress.yaml`, `k8s/configmap.yaml`
- Modify: `shared/scripts/deploy-queue/registry.sh` (remove the temporary deny entry)
- Modify: `docs/12_validation/VAL-TASK-001-bootstrap-service.md`

**Interfaces:**
- Consumes: the Secret `screencast-recorder-secret` (13 keys, already synced)
- Produces: a running deployment on 3391 behind `screencast.alfares.cz`

- [ ] **Step 1: Wire the deployment to the Secret**

Every one of the 13 keys is consumed via `secretKeyRef` from `screencast-recorder-secret`. Set probes:

```yaml
livenessProbe:
  httpGet: { path: /health, port: 3391 }
  initialDelaySeconds: 20
readinessProbe:
  httpGet: { path: /health, port: 3391 }
  initialDelaySeconds: 5
```

- [ ] **Step 2: Dry-run the shared deploy**

```bash
../shared/scripts/deploy.sh screencast-recorder --dry-run
```

Expected: preflight passes. The IPS gates already pass; this checks manifests and config.

- [ ] **Step 3: Remove the temporary deny-list entry**

In `shared/scripts/deploy-queue/registry.sh`, delete the `screencast-recorder` entry **and its comment block**. It exists only because the repo had no application code; that is no longer true.

- [ ] **Step 4: Deploy and verify by pod age, not by log lines**

```bash
../shared/scripts/deploy.sh screencast-recorder
kubectl get pods -n statex-apps -l app=screencast-recorder
curl -s https://screencast.alfares.cz/health
```

Expected: a pod younger than the deploy, `1/1 Running`, and `{"status":"ok","service":"screencast-recorder"}`. Compare pod age against commit time; matching log lines has produced false greens before.

- [ ] **Step 5: Confirm all 13 keys reached the pod**

```bash
kubectl exec -n statex-apps deploy/screencast-recorder -- \
  sh -c 'for k in DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD MINIO_ENDPOINT_URL \
    MINIO_BUCKET MINIO_ACCESS_KEY MINIO_SECRET_KEY AUTH_SERVICE_URL \
    LOGGING_SERVICE_URL MONITORING_SERVICE_URL AGENT_BEARER; do \
    [ -n "$(printenv $k)" ] && echo "$k set" || echo "$k MISSING"; done'
```

Expected: 13 × `set`. Prints only presence, never a value.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: deploy the screencast-recorder API on 3391"
```

---

## Definition of done

- `GET /health` answers on `https://screencast.alfares.cz`, and Kubernetes probes pass.
- All three tables exist in `screencast`, owned by `screencast_app`.
- An undecorated machine route is denied and error-logged; a token without the pair role is rejected; the correct role is accepted.
- A session cannot reach `uploading` without passing through `review`.
- A session reaches `stored` only when object readback verifies every key derived from its manifest.
- The UI's source list comes from reported capabilities, and the absent webcam shows as unavailable rather than as an error.
- All 13 secret keys are present in the pod, verified by name.
- The temporary deny-list entry is removed.
