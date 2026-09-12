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

    // Checked on the way in, before waiting out a poll window: a command past
    // the redelivery cap is one the agent could not survive, and its session
    // must be failed rather than left in a phase it will never leave. The
    // failure goes through reportStatus so it takes the same path, and lands in
    // the same console field, as a failure the agent reported itself.
    for (const dead of await this.commands.abandoned(id)) {
      // Only a session that can still legally fail is failed. One already
      // stored, discarded, failed or in review is finished with, and its
      // abandoned command is merely stale -- pushing a failure at it would
      // throw the transition guard's 400 out of this poll route and take the
      // agent's heartbeat down with it. Retiring the command is the whole job
      // in that case.
      if (await this.sessions.canFail(dead.sessionId)) {
        await this.sessions.reportStatus(dead.sessionId, {
          agent_id: id,
          state: 'failed',
          reason: 'command_unacknowledged',
        } as StatusDto);
      }
      await this.commands.retire(dead.commandId);
    }

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

  /**
   * The agent confirming it applied a command. Only this retires the command
   * from the queue; without it the command is offered again once its lease
   * expires, which is how a stop survives the agent dying mid-handling.
   */
  @Post('agents/:id/commands/:commandId/ack')
  @AgentRoute()
  @UseGuards(AgentRoleGuard)
  @HttpCode(200)
  async ack(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('commandId', ParseUUIDPipe) commandId: string,
  ): Promise<{ accepted: true }> {
    await this.commands.acknowledge(id, commandId);
    return { accepted: true };
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
