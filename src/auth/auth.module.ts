import { Logger, Module } from '@nestjs/common';
import { AgentRoleGuard } from './agent-role.guard';
import { AuthController } from './auth.controller';
import { TokenValidator } from './token-validator';
import { UserAuthGuard } from './user-auth.guard';

@Module({
  controllers: [AuthController],
  providers: [TokenValidator, AgentRoleGuard, UserAuthGuard, Logger],
  exports: [TokenValidator, AgentRoleGuard, UserAuthGuard],
})
export class AuthModule {}
