import { buildPullerArgs, PullerSupervisor } from './puller';

describe('buildPullerArgs', () => {
  const spec = {
    sourceUrl: 'http://admin:admin@192.168.88.232:8081/video',
    device: '/dev/video9',
  };

  it('reads the camera stream and writes the loopback device', () => {
    const args = buildPullerArgs(spec).join(' ');
    expect(args).toContain('-f mjpeg');
    expect(args).toContain(spec.sourceUrl);
    expect(args).toContain('-f v4l2');
    expect(args).toContain('/dev/video9');
  });

  it('converts to a pixel format a V4L2 consumer can read', () => {
    // The phone sends yuvj420p (full-range JPEG). Writing that straight to the
    // loopback makes every reader negotiate a format ffmpeg warns is
    // deprecated, and some refuse it outright.
    expect(buildPullerArgs(spec).join(' ')).toContain('format=yuv420p');
  });

  it('names no geometry, so the phone decides the resolution', () => {
    // The operator changes resolution in the phone app; pinning a size here
    // would either downscale it or fail to open the device.
    expect(buildPullerArgs(spec).join(' ')).not.toContain('-video_size');
  });
});

describe('PullerSupervisor', () => {
  /** A fake child process good enough for the lifecycle under test. */
  const fakeChild = () => {
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
    return {
      pid: 4242,
      killed: false,
      stderr: { on: jest.fn() },
      on: jest.fn((event: string, fn: (arg?: unknown) => void) => {
        (handlers[event] ??= []).push(fn);
      }),
      kill: jest.fn(function (this: { killed: boolean }) {
        this.killed = true;
      }),
      emit: (event: string, arg?: unknown) => (handlers[event] ?? []).forEach((fn) => fn(arg)),
    };
  };

  it('reports stopped before anything is started', () => {
    const supervisor = new PullerSupervisor({ spawnFn: () => fakeChild() as never });
    expect(supervisor.status().running).toBe(false);
  });

  it('reports running once started', () => {
    const supervisor = new PullerSupervisor({ spawnFn: () => fakeChild() as never });
    supervisor.start({ sourceUrl: 'http://cam/video', device: '/dev/video9' });
    expect(supervisor.status().running).toBe(true);
  });

  it('does not spawn a second puller when one is already running', () => {
    // Two writers on one loopback device is the state that wedged it in
    // practice: the second fails to attach and the first is left unreadable.
    const spawnFn = jest.fn(() => fakeChild() as never);
    const supervisor = new PullerSupervisor({ spawnFn });
    const spec = { sourceUrl: 'http://cam/video', device: '/dev/video9' };
    supervisor.start(spec);
    supervisor.start(spec);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('reports stopped after the child exits on its own', () => {
    // The puller has died repeatedly in practice -- the phone app restarting,
    // the host running out of memory. A status that still said "running"
    // would send the operator into a recording with no camera.
    const child = fakeChild();
    const supervisor = new PullerSupervisor({ spawnFn: () => child as never });
    supervisor.start({ sourceUrl: 'http://cam/video', device: '/dev/video9' });
    child.emit('close', 137);
    expect(supervisor.status().running).toBe(false);
    expect(supervisor.status().lastExitCode).toBe(137);
  });

  it('keeps the last error so the console can say why it stopped', () => {
    const child = fakeChild();
    const supervisor = new PullerSupervisor({ spawnFn: () => child as never });
    supervisor.start({ sourceUrl: 'http://cam/video', device: '/dev/video9' });
    child.emit('close', 237);
    expect(supervisor.status().lastExitCode).toBe(237);
  });

  it('stops a running puller', () => {
    const child = fakeChild();
    const supervisor = new PullerSupervisor({ spawnFn: () => child as never });
    supervisor.start({ sourceUrl: 'http://cam/video', device: '/dev/video9' });
    supervisor.stop();
    expect(child.kill).toHaveBeenCalled();
  });

  it('is safe to stop when nothing is running', () => {
    const supervisor = new PullerSupervisor({ spawnFn: () => fakeChild() as never });
    expect(() => supervisor.stop()).not.toThrow();
  });
});
