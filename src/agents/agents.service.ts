import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../sessions/entities/agent.entity';
import { CapabilitiesDto } from './dto/capabilities.dto';
import { EnrollDto } from './dto/enroll.dto';

/** How long an agent may be silent before the UI stops offering it. */
const ONLINE_WINDOW_MS = 60_000;

const POLL_INTERVAL_SECONDS = 5;

@Injectable()
export class AgentsService {
  constructor(
    @InjectRepository(Agent)
    private readonly agents: Repository<Agent>,
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
}
