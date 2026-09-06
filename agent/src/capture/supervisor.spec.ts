import { EventEmitter } from 'node:events';
import { CaptureSupervisor, SpawnFn } from './supervisor';

class FakeProc extends EventEmitter {
  killed: string[] = [];
  pid = 4242;
  stderr = new EventEmitter();
  kill(signal: string): boolean {
    this.killed.push(signal);
    return true;
  }
}

function makeSupervisor(opts: { graceMs?: number } = {}) {
  const procs: FakeProc[] = [];
  const spawn: SpawnFn = () => {
    const proc = new FakeProc();
    procs.push(proc);
    return proc as never;
  };
  const supervisor = new CaptureSupervisor(spawn, { graceMs: opts.graceMs ?? 10_000 });
  return { supervisor, procs };
}

const track = (id: string) => ({
  trackId: id,
  kind: 'screen',
  args: ['-hide_banner'],
  outDir: `/tmp/${id}`,
});

describe('CaptureSupervisor', () => {
  it('stops with SIGINT so the container finalises', async () => {
    const { supervisor, procs } = makeSupervisor();
    supervisor.start([track('t1')]);

    const stopping = supervisor.stopAll();
    // SIGKILL truncates the moov atom and leaves the final segment unplayable.
    expect(procs[0].killed).toEqual(['SIGINT']);

    procs[0].emit('exit', 0, null);
    await stopping;
  });

  it('escalates to SIGKILL only after the grace period', async () => {
    const { supervisor, procs } = makeSupervisor({ graceMs: 30 });
    supervisor.start([track('t1')]);

    const stopping = supervisor.stopAll();
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Last resort: a wedged ffmpeg must not hold the session open forever.
    expect(procs[0].killed).toContain('SIGKILL');

    procs[0].emit('exit', 137, 'SIGKILL');
    await stopping;
  });

  it('marks one track degraded without stopping the others', () => {
    const { supervisor, procs } = makeSupervisor();
    supervisor.start([track('screen'), track('audio')]);

    // A dead encoder should cost one source, not the whole session.
    procs[0].emit('exit', 1, null);

    expect(supervisor.stateOf('screen')?.degraded).toBe(true);
    expect(supervisor.stateOf('screen')?.running).toBe(false);
    expect(supervisor.stateOf('audio')?.running).toBe(true);
  });

  it('does not mark a track degraded when it exits cleanly on stop', async () => {
    const { supervisor, procs } = makeSupervisor();
    supervisor.start([track('t1')]);

    const stopping = supervisor.stopAll();
    procs[0].emit('exit', 0, null);
    await stopping;

    expect(supervisor.stateOf('t1')?.degraded).toBe(false);
  });

  it('treats exit on SIGINT during a stop as clean', () => {
    // ffmpeg exits 255 when interrupted; that is the normal stop path, not a
    // failure worth flagging to the operator.
    const { supervisor, procs } = makeSupervisor();
    supervisor.start([track('t1')]);
    void supervisor.stopAll();
    procs[0].emit('exit', 255, 'SIGINT');
    expect(supervisor.stateOf('t1')?.degraded).toBe(false);
  });

  it('reports whether any track is still running', () => {
    const { supervisor, procs } = makeSupervisor();
    supervisor.start([track('a'), track('b')]);
    expect(supervisor.anyRunning()).toBe(true);

    procs[0].emit('exit', 1, null);
    expect(supervisor.anyRunning()).toBe(true);

    procs[1].emit('exit', 1, null);
    expect(supervisor.anyRunning()).toBe(false);
  });

  it('keeps the last stderr line for a failed track, for the operator', () => {
    const { supervisor, procs } = makeSupervisor();
    supervisor.start([track('t1')]);

    procs[0].stderr.emit('data', Buffer.from('Cannot open display :0.0\n'));
    procs[0].emit('exit', 1, null);

    expect(supervisor.stateOf('t1')?.lastError).toContain('Cannot open display');
  });
});
