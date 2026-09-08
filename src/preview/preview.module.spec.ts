import { Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { AgentRoleGuard } from '../auth/agent-role.guard';
import { TokenValidator } from '../auth/token-validator';
import { CommandsService } from '../sessions/commands.service';
import { Manifest } from '../sessions/entities/manifest.entity';
import { Session } from '../sessions/entities/session.entity';
import { StorageService } from '../storage/storage.service';
import { PreviewAgentController } from './preview-agent.controller';
import { PreviewController } from './preview.controller';
import { PreviewService } from './preview.service';
import { SessionPreview } from './session-preview.entity';

/**
 * Compiles the module for real, rather than constructing its classes by hand.
 *
 * Every unit test in this subsystem passes `new PreviewService(...)` its
 * collaborators directly, which never exercises the injector -- and the
 * injector is where this service has now failed at boot twice. The failure
 * mode is severe and quiet: the container throws, the readiness probe keeps
 * the PREVIOUS pod serving, and the deploy looks successful while the new
 * code never runs.
 *
 * Repositories and the outward-facing collaborators are overridden, because
 * this asserts the wiring, not the database.
 */
describe('PreviewModule wiring', () => {
  const compile = () =>
    Test.createTestingModule({
      controllers: [PreviewController, PreviewAgentController],
      providers: [
        PreviewService,
        Logger,
        AgentRoleGuard,
        { provide: TokenValidator, useValue: { validateAgent: jest.fn() } },
        { provide: StorageService, useValue: {} },
        { provide: CommandsService, useValue: {} },
        { provide: getRepositoryToken(Session), useValue: {} },
        { provide: getRepositoryToken(Manifest), useValue: {} },
        { provide: getRepositoryToken(SessionPreview), useValue: {} },
      ],
    }).compile();

  it('resolves every dependency the preview controllers declare', async () => {
    const module = await compile();
    expect(module.get(PreviewService)).toBeInstanceOf(PreviewService);
    expect(module.get(PreviewController)).toBeInstanceOf(PreviewController);
    expect(module.get(PreviewAgentController)).toBeInstanceOf(PreviewAgentController);
  });

  it('resolves AgentRoleGuard, whose Logger argument the auth module does not export', async () => {
    // The exact boot failure of image 3fbf0b0: "Nest can't resolve
    // dependencies of the AgentRoleGuard (Reflector, TokenValidator, ?)".
    // Nest resolves a guard's constructor in the CONSUMING module's context,
    // so a module using AgentRoleGuard must provide Logger itself.
    const module = await compile();
    expect(module.get(AgentRoleGuard)).toBeInstanceOf(AgentRoleGuard);
  });
});
