import { Logger, Module } from '@nestjs/common';
import { AgentRoleGuard } from './agent-role.guard';
import { TokenValidator } from './token-validator';

@Module({
  providers: [TokenValidator, AgentRoleGuard, Logger],
  exports: [TokenValidator, AgentRoleGuard],
})
export class AuthModule {}
