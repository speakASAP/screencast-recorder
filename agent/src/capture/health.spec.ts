// agent/src/capture/health.spec.ts
import { HealthTracker } from './health';

describe('HealthTracker', () => {
  it('says nothing on the first observation, because there is no delta yet', () => {
    // A session's first tick has no previous sample. Alarming here would fire
    // on every recording at second five.
    const tracker = new HealthTracker();
    const health = tracker.observe([
      { trackId: 't1', kind: 'screen', bytes: 0 },
      { trackId: 't2', kind: 'audio', bytes: 0 },
    ]);

    expect(health.get('t1')).toBe('ok');
    expect(health.get('t2')).toBe('ok');
  });

  it('marks a track stalled after three ticks of no new bytes while another advances', () => {
    // The 2026-09-10 case: one microphone produced 914 KB in 21 minutes while
    // its sibling produced 31 MB, and reported healthy throughout.
    const tracker = new HealthTracker({ stallTicks: 3 });
    for (let tick = 1; tick <= 4; tick += 1) {
      var health = tracker.observe([
        { trackId: 't1', kind: 'screen', bytes: tick * 1_000_000 },
        { trackId: 't2', kind: 'audio', bytes: 500 },
      ]);
    }

    expect(health!.get('t1')).toBe('ok');
    expect(health!.get('t2')).toBe('stalled');
  });

  it('does not mark a track stalled while every track is idle', () => {
    // If nothing is advancing, the session is paused or ending -- that is not
    // one track failing, and flagging all of them is noise.
    const tracker = new HealthTracker({ stallTicks: 3 });
    for (let tick = 1; tick <= 5; tick += 1) {
      var health = tracker.observe([
        { trackId: 't1', kind: 'screen', bytes: 1000 },
        { trackId: 't2', kind: 'audio', bytes: 500 },
      ]);
    }

    expect(health!.get('t1')).toBe('ok');
    expect(health!.get('t2')).toBe('ok');
  });

  it('recovers to ok when bytes start flowing again', () => {
    const tracker = new HealthTracker({ stallTicks: 2 });
    tracker.observe([
      { trackId: 't1', kind: 'screen', bytes: 1_000_000 },
      { trackId: 't2', kind: 'audio', bytes: 500 },
    ]);
    tracker.observe([
      { trackId: 't1', kind: 'screen', bytes: 2_000_000 },
      { trackId: 't2', kind: 'audio', bytes: 500 },
    ]);
    tracker.observe([
      { trackId: 't1', kind: 'screen', bytes: 3_000_000 },
      { trackId: 't2', kind: 'audio', bytes: 500 },
    ]);
    const health = tracker.observe([
      { trackId: 't1', kind: 'screen', bytes: 4_000_000 },
      { trackId: 't2', kind: 'audio', bytes: 900_000 },
    ]);

    expect(health.get('t2')).toBe('ok');
  });

  it('marks an audio track quiet when its byte rate is under the floor', () => {
    // Advisory only. A silent room produces a legitimately small AAC stream,
    // so this warns and never blocks.
    const tracker = new HealthTracker({ stallTicks: 3, quietBytesPerTick: 10_000 });
    tracker.observe([
      { trackId: 't1', kind: 'screen', bytes: 1_000_000 },
      { trackId: 't2', kind: 'audio', bytes: 0 },
    ]);
    const health = tracker.observe([
      { trackId: 't1', kind: 'screen', bytes: 5_000_000 },
      { trackId: 't2', kind: 'audio', bytes: 40 },
    ]);

    expect(health.get('t2')).toBe('quiet');
  });

  it('never calls a screen track quiet, because the floor is an audio rule', () => {
    const tracker = new HealthTracker({ stallTicks: 3, quietBytesPerTick: 10_000 });
    tracker.observe([{ trackId: 't1', kind: 'screen', bytes: 0 }]);
    const health = tracker.observe([{ trackId: 't1', kind: 'screen', bytes: 40 }]);

    expect(health.get('t1')).not.toBe('quiet');
  });

  it('never calls a metadata track stalled, since it writes one growing file', () => {
    // events.jsonl grows in small bursts and has no segments; the stall rule
    // does not describe it.
    const tracker = new HealthTracker({ stallTicks: 2 });
    for (let tick = 1; tick <= 4; tick += 1) {
      var health = tracker.observe([
        { trackId: 't1', kind: 'screen', bytes: tick * 1_000_000 },
        { trackId: 't2', kind: 'metadata', bytes: 100 },
      ]);
    }

    expect(health!.get('t2')).toBe('ok');
  });
});
