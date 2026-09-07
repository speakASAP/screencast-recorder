import { Logger, Module } from '@nestjs/common';
import { AgentRoleGuard } from './agent-role.guard';
import { AuthController } from './auth.controller';
import { TokenValidator } from './token-validator';
import { SessionStore } from './session.store';
import { UserAuthGuard } from './user-auth.guard';

@Module({
  controllers: [AuthController],
  providers: [TokenValidator, AgentRoleGuard, UserAuthGuard, SessionStore, Logger],
  exports: [TokenValidator, AgentRoleGuard, UserAuthGuard, SessionStore],
})
export class AuthModule {}
