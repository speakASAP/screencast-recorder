import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AgentRoleGuard } from '../auth/agent-role.guard';
import { AgentRoute } from '../auth/agent-roles.decorator';
import { AgentsService } from './agents.service';
import { CapabilitiesDto } from './dto/capabilities.dto';
import { EnrollDto } from './dto/enroll.dto';

@Controller('api/agents')
@UseGuards(AgentRoleGuard)
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Post('enroll')
  @AgentRoute()
  enroll(@Body() dto: EnrollDto) {
    return this.agents.enroll(dto);
  }

  @Post(':id/capabilities')
  @AgentRoute()
  reportCapabilities(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CapabilitiesDto,
  ) {
    return this.agents.reportCapabilities(id, dto);
  }

  // Read-only listing for the operator UI. Classified by effect: this only
  // reads, so it is safe for the agent role too, and the UI reads it through
  // its own authenticated session.
  @Get()
  @AgentRoute()
  list() {
    return this.agents.listAll();
  }
}
