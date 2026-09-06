import { SessionState } from './entities/session.entity';
import { ManifestService } from './manifest.service';

type Row = Record<string, unknown>;

function makeService(
  verify: { verified: boolean; missing: string[] },
  state: SessionState = SessionState.Uploading,
) {
  const session: Row = { id: 's1', state, s3Prefix: 'sessions/2026/09/06/s1', startedAt: new Date() };
  const manifests: Row[] = [];
  const sessionsRepo = {
    findOne: jest.fn(async () => session),
    save: jest.fn(async (s: Row) => Object.assign(session, s)),
  };
  const tracksRepo = {
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    save: jest.fn(async (t: unknown) => t),
  };
  const manifestRepo = {
    create: jest.fn((m: Row) => m),
    save: jest.fn(async (m: Row) => {
      manifests.push(m);
      return m;
    }),
    find: jest.fn(async () => manifests),
  };
  const storage = {
    verifySession: jest.fn(async (_prefix: string, _keys: string[]) => verify),
  };

  const service = new ManifestService(
    sessionsRepo as never,
    tracksRepo as never,
    manifestRepo as never,
    storage as never,
  );
  return { service, session, storage, manifests };
}

const manifestWith = (segments: number) => ({
  agent_id: '11111111-1111-1111-1111-111111111111',
  started_at: new Date().toISOString(),
  ended_at: new Date().toISOString(),
  clock_offset_ms: 3,
  tracks: [
    {
      track_id: '22222222-2222-2222-2222-222222222222',
      kind: 'screen',
      source_ref: 'HDMI-A-0',
      codec: 'h264_vaapi',
      fps: 15,
      pts_origin_ms: 0,
      segments: Array.from({ length: segments }, (_, i) => ({
        index: i,
        file: `seg-${String(i).padStart(5, '0')}.mp4`,
        start_ms: i * 60000,
        end_ms: (i + 1) * 60000,
        bytes: 1000,
      })),
    },
  ],
});

describe('upload completion', () => {
  it('refuses to mark stored when verification finds a gap', async () => {
    // The agent claiming success is not evidence; readback is.
    const { service, session } = makeService({ verified: false, missing: ['p/seg-00003.mp4'] });
    await service.ingestManifest('s1', manifestWith(4) as never);
    await expect(
      service.completeUpload('s1', { agent_id: 'a', objects: 4, bytes: 4000, verified: true } as never),
    ).rejects.toThrow();
    expect(session.state).not.toBe(SessionState.Stored);
  });

  it('marks stored when every object reads back', async () => {
    const { service, session } = makeService({ verified: true, missing: [] });
    await service.ingestManifest('s1', manifestWith(2) as never);
    await service.completeUpload('s1', {
      agent_id: 'a', objects: 3, bytes: 2000, verified: true,
    } as never);
    expect(session.state).toBe(SessionState.Stored);
  });

  it('derives expected keys from the manifest, not from the agent claim', async () => {
    // Otherwise an agent that under-reports its own segments verifies clean.
    const { service, storage } = makeService({ verified: true, missing: [] });
    await service.ingestManifest('s1', manifestWith(3) as never);
    await service.completeUpload('s1', {
      agent_id: 'a', objects: 1, bytes: 1, verified: true,
    } as never);

    const expectedKeys = storage.verifySession.mock.calls[0][1] as string[];
    expect(expectedKeys.some((k) => k.includes('seg-00002.mp4'))).toBe(true);
    expect(expectedKeys.some((k) => k.endsWith('manifest.json'))).toBe(true);
  });

  it('rejects an upload completion for a session that never sent a manifest', async () => {
    const { service } = makeService({ verified: false, missing: [] });
    await expect(
      service.completeUpload('s1', { agent_id: 'a', objects: 0, bytes: 0, verified: true } as never),
    ).rejects.toThrow();
  });

  it('refuses to complete an upload from a state that is not uploading', async () => {
    const { service } = makeService({ verified: true, missing: [] }, SessionState.Recording);
    await service.ingestManifest('s1', manifestWith(1) as never);
    await expect(
      service.completeUpload('s1', { agent_id: 'a', objects: 2, bytes: 1, verified: true } as never),
    ).rejects.toThrow();
  });
});
