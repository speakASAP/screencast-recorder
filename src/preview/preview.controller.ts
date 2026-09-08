import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PreviewService } from './preview.service';

/** Default bucket count: roughly one per horizontal pixel of the timeline. */
const DEFAULT_BUCKETS = 1000;

/** Ceiling, so a crafted query cannot ask for an unbounded response. */
const MAX_BUCKETS = 5000;

/**
 * Operator-lane preview routes.
 *
 * Deliberately carries neither @AgentRoute() nor @Public(): the global
 * UserAuthGuard covers these, and preview is an operator feature. The agent's
 * only involvement is the render-preview command it receives on its own
 * authenticated channel.
 */
@Controller('api/sessions')
export class PreviewController {
  constructor(private readonly preview: PreviewService) {}

  @Get(':id/preview')
  status(@Param('id', ParseUUIDPipe) id: string) {
    return this.preview.status(id);
  }

  /** No source parameter: one render produces every audio source. */
  @Post(':id/preview')
  requestRender(@Param('id', ParseUUIDPipe) id: string) {
    return this.preview.requestRender(id);
  }

  /** Records which microphone the operator chose, so a reload does not revert it. */
  @Post(':id/preview/source')
  selectSource(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('sourceRef') sourceRef: string,
  ) {
    return this.preview.selectSource(id, sourceRef);
  }

  /**
   * Redirects rather than streaming: the API must not become the data path
   * for video, and a redirect lets the browser's Range requests reach MinIO
   * directly, which is what makes seeking work.
   */
  @Get(':id/preview/media')
  async media(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    res.redirect(302, await this.preview.videoUrl(id));
  }

  /**
   * One audio proxy per source, each separately addressable.
   *
   * Separate objects rather than extra streams in the video: a browser plays
   * only the first audio track of a <video> and exposes no switcher, so
   * muxing would leave every source but one unreachable.
   */
  @Get(':id/preview/audio/:sourceRef')
  async audio(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sourceRef') sourceRef: string,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(302, await this.preview.audioUrl(id, sourceRef));
  }

  /**
   * One source's waveform, precomputed at render time.
   *
   * The console draws a lane per source from this instead of decoding the
   * audio itself: a four-hour proxy would otherwise be downloaded in full
   * before a single lane appeared.
   */
  @Get(':id/preview/peaks/:sourceRef')
  async peaks(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sourceRef') sourceRef: string,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(302, await this.preview.peaksUrl(id, sourceRef));
  }

  @Get(':id/timeline')
  timeline(@Param('id', ParseUUIDPipe) id: string, @Query('buckets') buckets?: string) {
    const requested = Number(buckets);
    const count =
      Number.isFinite(requested) && requested > 0
        ? Math.min(MAX_BUCKETS, Math.floor(requested))
        : DEFAULT_BUCKETS;
    return this.preview.timeline(id, count);
  }
}
