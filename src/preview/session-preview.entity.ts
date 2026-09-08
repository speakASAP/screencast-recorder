import { randomUUID } from 'node:crypto';
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

export enum PreviewState {
  Pending = 'pending',
  Rendering = 'rendering',
  Ready = 'ready',
  Failed = 'failed',
}

const LEGAL: Record<PreviewState, PreviewState[]> = {
  [PreviewState.Pending]: [PreviewState.Rendering, PreviewState.Failed],
  [PreviewState.Rendering]: [
    PreviewState.Ready,
    PreviewState.Failed,
    // A deferred render -- one refused because a recording was in progress,
    // so it never started -- returns to pending as its retry path once the
    // recording finishes. This is the render-complete callback's recovery
    // route, not a regression of the render.
    PreviewState.Pending,
  ],
  // Retry after a failure is the whole recovery path.
  [PreviewState.Failed]: [PreviewState.Rendering],
  // A ready proxy is reusable and is never re-rendered in place.
  [PreviewState.Ready]: [],
};

export function isLegalPreviewTransition(from: PreviewState, to: PreviewState): boolean {
  return LEGAL[from].includes(to);
}

/** One rendered object: the video proxy, or one source's audio proxy. */
export interface PreviewArtifact {
  kind: 'video' | 'audio';
  /** Null for the video proxy, which carries no audio stream. */
  sourceRef: string | null;
  objectKey: string;
  bytes: number;
  durationMs: number | null;
  /**
   * Measured level, for audio artifacts only.
   *
   * Carried on the artifact rather than in a column of its own because it is
   * produced by the same render pass that produced the file, and is only
   * meaningful about that file. A level without its proxy would describe a
   * source the operator cannot listen to.
   */
  meanDb?: number;
  maxDb?: number;
}

/**
 * One preview per session -- NOT one per audio source.
 *
 * A render produces the whole set at once (the video proxy plus one audio
 * proxy per source), because every source must be reachable: a browser plays
 * only the first audio track of a <video>, so muxing would strand all but one.
 * Rendering them together means switching source in the console costs nothing
 * and needs no second render.
 *
 * The artifact list is what makes completeness checkable rather than assumed:
 * a session with three audio sources and two audio proxies is incomplete, and
 * must be visible as such rather than quietly offering two.
 */
@Entity('session_previews')
@Index(['sessionId'], { unique: true })
export class SessionPreview {
  @PrimaryColumn({ type: 'uuid' })
  id: string = randomUUID();

  @Column({ type: 'uuid' })
  sessionId!: string;

  @Column({ type: 'text', default: PreviewState.Pending })
  state!: PreviewState;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  artifacts!: PreviewArtifact[];

  /** Which path the render read from; the two have very different waits. */
  @Column({ type: 'text', nullable: true })
  sourcePath!: 'local' | 'storage' | null;

  @Column({ type: 'text', nullable: true })
  failureReason!: string | null;

  /**
   * The source the operator chose, when they chose one.
   *
   * Null means the console shows the automatic pick (the loudest measured
   * source). Persisted rather than held in the page so that reopening a
   * session does not silently revert to a different microphone than the one
   * the operator settled on.
   */
  @Column({ type: 'text', nullable: true })
  selectedSourceRef!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  requestedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  readyAt!: Date | null;
}
