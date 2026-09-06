import { Controller, Get } from '@nestjs/common';
import { AgentsService } from '../agents/agents.service';

/** An agent silent for longer than this is not offered as a recording target. */
const ONLINE_WINDOW_MS = 60_000;

export interface UiSource {
  id: string;
  kind: 'screen' | 'audio' | 'webcam';
  label: string;
}

export interface UiUnavailable {
  kind: 'screen' | 'audio' | 'webcam';
  reason: string;
}

export interface UiAgent {
  id: string;
  hostname: string;
  online: boolean;
  lastSeenAt: string | null;
  sources: UiSource[];
  unavailable: UiUnavailable[];
  freeDiskBytes: number | null;
  encoders: string[];
}

interface RawDisplay {
  id: string;
  width?: number;
  height?: number;
}
interface RawNamed {
  id: string;
  label?: string;
}

/**
 * Shapes agent capability reports into what the operator's source picker
 * renders.
 *
 * Everything here is derived from what the agent actually reported. Nothing is
 * hardcoded: a display list baked into the frontend is wrong on the next
 * machine and wrong on this one the moment a monitor is unplugged.
 */
@Controller('api/ui')
export class UiController {
  constructor(private readonly agents: AgentsService) {}

  @Get('agents')
  async agentsView(): Promise<UiAgent[]> {
    const agents = await this.agents.listAll();

    return agents.map((agent) => {
      const caps = (agent.capabilities ?? {}) as {
        displays?: RawDisplay[];
        audio_inputs?: RawNamed[];
        cameras?: RawNamed[];
        encoders?: string[];
        free_disk_bytes?: number;
      };

      const displays = caps.displays ?? [];
      const audio = caps.audio_inputs ?? [];
      const cameras = caps.cameras ?? [];

      const sources: UiSource[] = [
        ...displays.map((d) => ({
          id: d.id,
          kind: 'screen' as const,
          // Resolution in the label, so two monitors are told apart at a glance.
          label: d.width && d.height ? `${d.id} (${d.width}x${d.height})` : d.id,
        })),
        ...audio.map((a) => ({ id: a.id, kind: 'audio' as const, label: a.label ?? a.id })),
        ...cameras.map((c) => ({ id: c.id, kind: 'webcam' as const, label: c.label ?? c.id })),
      ];

      // An absent device is a missing capability, not an error. Saying so keeps
      // the operator from wondering whether the feature is broken.
      const unavailable: UiUnavailable[] = [];
      if (displays.length === 0) unavailable.push({ kind: 'screen', reason: 'no display detected' });
      if (audio.length === 0) unavailable.push({ kind: 'audio', reason: 'no audio input detected' });
      if (cameras.length === 0) unavailable.push({ kind: 'webcam', reason: 'no camera detected' });

      const lastSeen = agent.lastSeenAt ? new Date(agent.lastSeenAt) : null;

      return {
        id: agent.id,
        hostname: agent.hostname,
        online: lastSeen !== null && Date.now() - lastSeen.getTime() < ONLINE_WINDOW_MS,
        lastSeenAt: lastSeen ? lastSeen.toISOString() : null,
        sources,
        unavailable,
        freeDiskBytes: caps.free_disk_bytes ?? null,
        encoders: caps.encoders ?? [],
      };
    });
  }
}
