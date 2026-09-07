import { mkdir, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { ActivityTracker } from '../activity/tracker';
import { InputListener, SpawnFn } from '../activity/input-listener';
import { buildManifest, collectSegments, Manifest } from '../manifest';
import { buildAudioArgs, buildScreenArgs } from './ffmpeg';
import { CaptureSupervisor, TrackSpec } from './supervisor';

export interface TrackRequest {
  track_id: string;
  kind: 'screen' | 'audio' | 'webcam' | 'metadata';
  source_ref: string;
  codec?: string;
  fps?: number;
  segment_seconds?: number;
  sample_hz?: number;
  bitrate_kbps?: number;
}

/** Test seam. Production passes nothing and the listener spawns real xinput. */
export interface StartOptions {
  spawnInput?: SpawnFn;
}

export interface SessionContext {
  sessionId: string;
  hostname: string;
  display: string;
  rootDir: string;
  displays: { id: string; width: number; height: number; x: number; y: number }[];
}

/**
 * One recording session on this host.
 *
 * Owns the local directory layout, which mirrors the S3 key layout exactly so
 * upload is a path prefix and nothing has to be re-derived:
 *
 *   <root>/<session-id>/<kind>-<source_ref>/seg-NNNNN.<ext>
 *   <root>/<session-id>/metadata/events.jsonl
 */
export class CaptureSession {
  private readonly supervisor = new CaptureSupervisor();
  private tracker: ActivityTracker | null = null;
  private inputListener: InputListener | null = null;
  private tracks: TrackRequest[] = [];
  private startedAt: Date | null = null;
  private endedAt: Date | null = null;

  constructor(private readonly context: SessionContext) {}

  get dir(): string {
    return join(this.context.rootDir, this.context.sessionId);
  }

  /**
   * Directory for one track, named so the S3 key needs no translation.
   *
   * The hostname segment is load-bearing, not decoration: a session can span
   * two machines, and without it both would write `screen-HDMI-A-0` into the
   * same prefix and overwrite each other. It is also what the API's storage
   * verification expects, so omitting it makes a complete upload look like a
   * session with missing objects.
   */
  trackDir(track: TrackRequest): string {
    const folder = track.kind === 'metadata' ? 'metadata' : `${track.kind}-${track.source_ref}`;
    return join(this.dir, this.context.hostname, folder);
  }

  async start(tracks: TrackRequest[], clockOffsetMs: number, options: StartOptions = {}): Promise<void> {
    this.tracks = tracks;
    this.startedAt = new Date();
    this.clockOffsetMs = clockOffsetMs;

    const specs: TrackSpec[] = [];

    for (const track of tracks) {
      const outDir = this.trackDir(track);
      await mkdir(outDir, { recursive: true });

      if (track.kind === 'screen') {
        const display = this.context.displays.find((d) => d.id === track.source_ref);
        if (!display) {
          // Refuse rather than capture the wrong monitor: a session recorded
          // from the wrong screen is discovered only on playback.
          throw new Error(`display ${track.source_ref} is no longer present`);
        }

        specs.push({
          trackId: track.track_id,
          kind: track.kind,
          outDir,
          args: buildScreenArgs({
            display: this.context.display,
            width: display.width,
            height: display.height,
            x: display.x,
            y: display.y,
            fps: track.fps ?? 15,
            codec: track.codec ?? 'h264_vaapi',
            segmentSeconds: track.segment_seconds ?? 60,
            outDir,
          }),
        });
      } else if (track.kind === 'audio') {
        specs.push({
          trackId: track.track_id,
          kind: track.kind,
          outDir,
          args: buildAudioArgs({
            source: track.source_ref,
            codec: track.codec ?? 'aac',
            bitrateKbps: track.bitrate_kbps ?? 192,
            segmentSeconds: track.segment_seconds ?? 60,
            outDir,
          }),
        });
      } else if (track.kind === 'metadata') {
        const tracker = new ActivityTracker(
          join(outDir, 'events.jsonl'),
          track.sample_hz ?? 5,
          this.context.displays[0]?.id ?? 'unknown',
        );
        this.tracker = tracker;

        // The counters are useless without a producer, and for the whole of
        // Phase 1 there was not one: `countKey`/`countClick` had no caller and
        // every stored session read `keys: 0, clicks: 0`. This is that wiring.
        //
        // It is deliberately built here, beside the tracker, so a metadata
        // track can never again start with nothing feeding it.
        this.inputListener = new InputListener({
          onKey: (hotkey) => tracker.countKey(hotkey),
          onClick: () => tracker.countClick(),
          spawnFn: options.spawnInput,
          onError: (message) => console.error(`[activity] ${message}`),
        });
      }
    }

    this.supervisor.start(specs);
    this.tracker?.start();
    // Started last and never awaited: input counting is the least important
    // thing here, and must not delay or fail the capture it annotates.
    this.inputListener?.start();
  }

  private clockOffsetMs = 0;

  /** Graceful stop, then the manifest. Both must happen before review. */
  async stop(agentId: string): Promise<Manifest> {
    await this.supervisor.stopAll();
    // Stopped before the tracker so the final sample cannot race a count.
    this.inputListener?.stop();
    this.inputListener = null;
    await this.tracker?.stop();
    this.endedAt = new Date();

    const manifestTracks = [];
    for (const track of this.tracks) {
      if (track.kind === 'metadata') continue;
      const extension = track.kind === 'audio' ? '.m4a' : '.mp4';
      manifestTracks.push({
        trackId: track.track_id,
        kind: track.kind,
        sourceRef: track.source_ref,
        codec: track.codec ?? null,
        fps: track.fps ?? null,
        segments: await collectSegments(this.trackDir(track), extension),
      });
    }

    const manifest = buildManifest({
      agentId,
      hostname: this.context.hostname,
      startedAt: this.startedAt ?? new Date(),
      endedAt: this.endedAt,
      clockOffsetMs: this.clockOffsetMs,
      tracks: manifestTracks,
    });

    // Written beside the media as well as posted to the API: the local copy is
    // what makes a session recoverable if the controller never comes back.
    await writeFile(join(this.dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  isRunning(): boolean {
    return this.supervisor.anyRunning();
  }

  states(): { trackId: string; degraded: boolean; segments: number; bytes: number }[] {
    const media = this.supervisor.states().map((s) => ({
      trackId: s.trackId,
      degraded: s.degraded,
      segments: s.segments,
      bytes: s.bytes,
    }));

    // The activity tracker is not an ffmpeg child, so the supervisor never
    // sees it. Without this its row shows 0 bytes while it is writing
    // hundreds of samples.
    const metadata = this.tracks.find((t) => t.kind === 'metadata');
    if (metadata && this.tracker) {
      let bytes = 0;
      try {
        bytes = statSync(join(this.trackDir(metadata), 'events.jsonl')).size;
      } catch {
        bytes = 0;
      }
      media.push({ trackId: metadata.track_id, degraded: false, segments: 0, bytes });
    }

    return media;
  }

  currentWindow(): string | null {
    return this.tracker?.currentWindow() ?? null;
  }
}
