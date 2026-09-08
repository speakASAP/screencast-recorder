import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AgentRoleGuard } from '../auth/agent-role.guard';
import { AgentRoute } from '../auth/agent-roles.decorator';
import { PreviewCompleteDto } from './dto/preview.dto';
import { PreviewService } from './preview.service';

/**
 * The one machine-lane preview route: the agent reporting a finished render.
 *
 * Deliberately a separate controller from PreviewController rather than one
 * more method on it. The two lanes are different identities -- an operator
 * session cookie against a pair-specific service token -- and keeping them in
 * separate classes means a test can assert that NO method of the operator
 * controller carries @AgentRoute(), which it cannot do if the lanes are
 * mixed. It also keeps the route out of SessionsController, which would make
 * SessionsModule and PreviewModule import each other.
 */
@Controller('api')
export class PreviewAgentController {
  constructor(private readonly preview: PreviewService) {}

  @Post('sessions/:id/preview-complete')
  @AgentRoute()
  @UseGuards(AgentRoleGuard)
  @HttpCode(200)
  previewComplete(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PreviewCompleteDto) {
    return this.preview.completeRender(id, dto);
  }
}
