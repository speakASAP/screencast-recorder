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
import { CommandsService } from './commands.service';
import { CreateSessionDto, ProgressDto, StatusDto } from './dto/session.dto';
import { SessionsService } from './sessions.service';

@Controller('api')
@UseGuards(AgentRoleGuard)
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly commands: CommandsService,
  ) {}

  @Post('sessions')
  @AgentRoute()
  create(@Body() dto: CreateSessionDto) {
    return this.sessions.create(dto);
  }

  @Get('sessions')
  @AgentRoute()
  list() {
    return this.sessions.list();
  }

  @Get('sessions/:id')
  @AgentRoute()
  byId(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.byId(id);
  }

  /**
   * Long poll. Returns 204 rather than an empty 200 so the agent can branch on
   * the status code without parsing a body.
   */
  @Get('agents/:id/commands')
  @AgentRoute()
  async next(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
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
  @HttpCode(200)
  status(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StatusDto) {
    return this.sessions.reportStatus(id, dto);
  }

  @Post('sessions/:id/progress')
  @AgentRoute()
  @HttpCode(200)
  progress(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ProgressDto) {
    return this.sessions.reportProgress(id, dto);
  }

  @Post('sessions/:id/stop')
  @AgentRoute()
  stop(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.stop(id);
  }

  @Post('sessions/:id/save')
  @AgentRoute()
  save(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.save(id);
  }

  @Post('sessions/:id/discard')
  @AgentRoute()
  discard(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.discard(id);
  }
}
