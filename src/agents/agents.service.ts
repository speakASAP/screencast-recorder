import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../sessions/entities/agent.entity';
import { Command, CommandType } from '../sessions/entities/command.entity';
import { CapabilitiesDto } from './dto/capabilities.dto';
import { EnrollDto } from './dto/enroll.dto';

/** How long an agent may be silent before the UI stops offering it. */
const ONLINE_WINDOW_MS = 60_000;

const POLL_INTERVAL_SECONDS = 5;

/**
 * Stands in for "no session" on a host-level command.
 *
 * The all-zero UUID is not a real session and never will be: session ids are
 * random v4, which cannot produce it.
 */
export const HOST_LEVEL_COMMAND_SESSION = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class AgentsService {
  constructor(
    @InjectRepository(Agent)
    private readonly agents: Repository<Agent>,
    @InjectRepository(Command)
    private readonly commands: Repository<Command>,
  ) {}

  async enroll(dto: EnrollDto): Promise<{ agent_id: string; poll_interval_seconds: number }> {
    // Idempotent on (hostname, machineId): an agent restart re-enrols, and a
    // second row would show the operator the same machine twice.
    const existing = await this.agents.findOne({
      where: { hostname: dto.hostname, machineId: dto.machine_id },
    });

    if (existing) {
      existing.lastSeenAt = new Date();
      existing.agentVersion = dto.agent_version ?? existing.agentVersion;
      await this.agents.save(existing);
      return { agent_id: existing.id, poll_interval_seconds: POLL_INTERVAL_SECONDS };
    }

    const created = this.agents.create({
      hostname: dto.hostname,
      machineId: dto.machine_id,
      platform: dto.platform,
      agentVersion: dto.agent_version ?? null,
      capabilities: {},
      lastSeenAt: new Date(),
    });
    const saved = await this.agents.save(created);
    return { agent_id: saved.id, poll_interval_seconds: POLL_INTERVAL_SECONDS };
  }

  async reportCapabilities(agentId: string, dto: CapabilitiesDto): Promise<{ accepted: true }> {
    const agent = await this.agents.findOne({ where: { id: agentId } });
    if (!agent) throw new NotFoundException('Unknown agent');

    // Assignment, not a merge. Hardware changes between runs: a camera is
    // unplugged, a monitor is disconnected. Merging would keep offering a
    // source that no longer exists, and the failure would only surface at
    // capture time, minutes into a session.
    agent.capabilities = dto as unknown as Record<string, unknown>;
    agent.lastSeenAt = new Date();
    await this.agents.save(agent);

    return { accepted: true };
  }

  /**
   * Records that an agent is alive.
   *
   * Called on every command poll. Enrolment and capability reports alone are
   * not enough: an agent that is running normally may go hours without either,
   * and the console would show it offline and refuse to start a session
   * against a perfectly healthy machine.
   */
  async touch(agentId: string): Promise<void> {
    await this.agents.update({ id: agentId }, { lastSeenAt: new Date() });
  }

  async listActive(): Promise<Agent[]> {
    const all = await this.agents.find({ order: { hostname: 'ASC' } });
    const cutoff = Date.now() - ONLINE_WINDOW_MS;
    return all.filter((a) => a.lastSeenAt !== null && a.lastSeenAt.getTime() >= cutoff);
  }

  async listAll(): Promise<Agent[]> {
    return this.agents.find({ order: { hostname: 'ASC' } });
  }

  async byId(agentId: string): Promise<Agent> {
    const agent = await this.agents.findOne({ where: { id: agentId } });
    if (!agent) throw new NotFoundException('Unknown agent');
    return agent;
  }

  /**
   * The last puller state an agent reported, and the command queue to change it.
   *
   * Held in memory rather than a column: it describes a process that lives and
   * dies with the agent, so a value that survived a restart would be a claim
   * about something that no longer exists.
   */
  private pullerState = new Map<string, Record<string, unknown>>();

  recordPullerState(agentId: string, state: Record<string, unknown>): void {
    this.pullerState.set(agentId, { ...state, reportedAt: new Date().toISOString() });
  }

  pullerStateFor(agentId: string): Record<string, unknown> | null {
    return this.pullerState.get(agentId) ?? null;
  }

  /**
   * Queues a puller change for the agent to pick up on its next poll.
   *
   * No session id: this acts on the host's camera plumbing, not on a
   * recording, and the operator uses it before any session exists.
   */
  async queuePullerCommand(agentId: string, action: 'start' | 'stop'): Promise<{ queued: string }> {
    const agent = await this.agents.findOne({ where: { id: agentId } });
    if (!agent) throw new NotFoundException(`Unknown agent ${agentId}`);

    await this.commands.save(
      this.commands.create({
        agentId,
        // The puller belongs to the host, not to any recording, but sessionId
        // is a non-null column. A fixed sentinel says "no session" without a
        // migration to make the column nullable for this one command type.
        sessionId: HOST_LEVEL_COMMAND_SESSION,
        type: CommandType.PullerControl,
        payload: { action },
        deliveredAt: null,
      }),
    );

    return { queued: action };
  }
}
