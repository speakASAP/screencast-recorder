import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AgentRoleGuard } from '../auth/agent-role.guard';
import { AgentRoute } from '../auth/agent-roles.decorator';
import { AgentsService } from './agents.service';
import { CapabilitiesDto } from './dto/capabilities.dto';
import { EnrollDto } from './dto/enroll.dto';

@Controller('api/agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Post('enroll')
  @AgentRoute()
  @UseGuards(AgentRoleGuard)
  enroll(@Body() dto: EnrollDto) {
    return this.agents.enroll(dto);
  }

  @Post(':id/capabilities')
  @AgentRoute()
  @UseGuards(AgentRoleGuard)
  reportCapabilities(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CapabilitiesDto,
  ) {
    return this.agents.reportCapabilities(id, dto);
  }

  /**
   * The agent reports its puller state here after acting on a command.
   *
   * A plain report rather than a response, because the agent has no inbound
   * HTTP surface: every exchange is the agent posting outward.
   */
  @Post('puller')
  @AgentRoute()
  @UseGuards(AgentRoleGuard)
  reportPuller(@Body() body: { agent_id: string } & Record<string, unknown>) {
    this.agents.recordPullerState(body.agent_id, body);
    return { ok: true };
  }

  /**
   * Operator route: read the puller state, or queue a change to it.
   *
   * The state can be one poll behind, which is why the console shows when it
   * was reported rather than presenting it as live truth.
   */
  @Get(':id/puller')
  pullerState(@Param('id', ParseUUIDPipe) id: string) {
    return this.agents.pullerStateFor(id) ?? { running: false, unknown: true };
  }

  @Post(':id/puller/:action')
  async controlPuller(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('action') action: string,
  ) {
    return this.agents.queuePullerCommand(id, action === 'start' ? 'start' : 'stop');
  }

  // Read-only listing for the operator UI. Classified by effect: this only
  // reads, so it is safe for the agent role too, and the UI reads it through
  // its own authenticated session.
  // Operator route: the console lists agents with a session cookie.
  @Get()
  list() {
    return this.agents.listAll();
  }
}
