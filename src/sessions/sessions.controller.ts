import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AgentRoleGuard } from '../auth/agent-role.guard';
import { AgentRoute } from '../auth/agent-roles.decorator';
import { AgentsService } from '../agents/agents.service';
import { CommandsService } from './commands.service';
import { ManifestDto, UploadCompleteDto } from './dto/manifest.dto';
import { ManifestService } from './manifest.service';
import { CreateSessionDto, ProgressDto, StatusDto } from './dto/session.dto';
import { SessionsService } from './sessions.service';

/**
 * Two identity lanes on one controller.
 *
 * Operator routes (create, read, stop, save, discard) are driven by the console
 * with a session cookie and are covered by the global UserAuthGuard. Machine
 * routes carry @AgentRoute() and are checked by AgentRoleGuard against the
 * pair-specific service token instead. The lanes are never interchangeable: an
 * operator cannot post a manifest, and the agent cannot press Save.
 */
@Controller('api')
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly commands: CommandsService,
    private readonly manifests: ManifestService,
    private readonly agents: AgentsService,
  ) {}

  @Post('sessions')
  create(@Body() dto: CreateSessionDto) {
    return this.sessions.create(dto);
  }

  @Get('sessions')
  list() {
    return this.sessions.list();
  }

  @Get('sessions/:id')
  byId(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.byId(id);
  }

  /**
   * Long poll. Returns 204 rather than an empty 200 so the agent can branch on
   * the status code without parsing a body.
   */
  @Get('agents/:id/commands')
  @AgentRoute()
  @UseGuards(AgentRoleGuard)
  async next(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    // The poll itself is the heartbeat: an idle agent may go hours without
    // enrolling or reporting capabilities, and it is still alive.
    await this.agents.touch(id);
    const command = await this.commands.nextFor(id);
    if (!command) {
      res.status(204).send();
      return;
    }
    res.status(200).json({
      command_id: command.id,
      type: command.type,
      session_id: command.sessionId,
      issued_at: command.issuedAt.toISOString(),
      payload: command.payload,
    });
  }

  @Post('sessions/:id/status')
  @AgentRoute()
  @UseGuards(AgentRoleGuard)
  @HttpCode(200)
  status(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StatusDto) {
    return this.sessions.reportStatus(id, dto);
  }

  @Post('sessions/:id/progress')
  @AgentRoute()
  @UseGuards(AgentRoleGuard)
  @HttpCode(200)
  progress(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ProgressDto) {
    return this.sessions.reportProgress(id, dto);
  }

  @Post('sessions/:id/manifest')
  @AgentRoute()
  @UseGuards(AgentRoleGuard)
  @HttpCode(200)
  manifest(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ManifestDto) {
    return this.manifests.ingestManifest(id, dto);
  }

  @Post('sessions/:id/upload-complete')
  @AgentRoute()
  @UseGuards(AgentRoleGuard)
  @HttpCode(200)
  uploadComplete(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UploadCompleteDto) {
    return this.manifests.completeUpload(id, dto);
  }

  @Post('sessions/:id/stop')
  stop(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.stop(id);
  }

  @Post('sessions/:id/save')
  save(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.save(id);
  }

  @Post('sessions/:id/discard')
  discard(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.discard(id);
  }
}
