import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentRoleGuard } from './agent-role.guard';
import { AuthController } from './auth.controller';
import { AuthSession } from './auth-session.entity';
import { TokenValidator } from './token-validator';
import { SessionStore } from './session.store';
import { UserAuthGuard } from './user-auth.guard';

@Module({
  // SessionStore reads and writes auth_sessions: the operator session has to
  // outlive the pod, or every deploy signs everyone out.
  imports: [TypeOrmModule.forFeature([AuthSession])],
  controllers: [AuthController],
  providers: [TokenValidator, AgentRoleGuard, UserAuthGuard, SessionStore, Logger],
  exports: [TokenValidator, AgentRoleGuard, UserAuthGuard, SessionStore],
})
export class AuthModule {}
