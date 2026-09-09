import { createServer, Server } from 'node:http';
import { ChildProcess, spawn } from 'node:child_process';

/**
 * The only interface this server may bind.
 *
 * The stream is a live camera pointed at the operator, and the agent has no
 * authentication to put in front of it. Binding anything else would publish it
 * to every host on the network. The console is opened from this same machine,
 * so the loopback interface is sufficient as well as safe.
 */
export const LOOPBACK_ONLY = '127.0.0.1';

/**
 * Builds the live preview command.
 *
 * `mpjpeg` -- MIME multipart JPEG -- is what makes this cheap: the browser
 * renders it in a plain <img> with no player library, no HLS segmenting and no
 * WebRTC signalling.
 *
 * Deliberately small and slow. The preview answers one question, "is the
 * camera alive and pointed at me", and a full-rate 1080p decode would compete
 * for CPU with the recording it is meant to precede.
 */
export function buildLivePreviewArgs(device: string): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'v4l2',
    '-i', device,
    '-vf', 'scale=640:-2',
    '-r', '10',
    '-f', 'mpjpeg',
    'pipe:1',
  ];
}

/**
 * Serves a live camera preview on the loopback interface.
 *
 * One ffmpeg per connected viewer, started on request and killed when the
 * response closes: nothing runs while the console is not looking, which
 * matters on a host that has already been short of memory once.
 */
export class LivePreviewServer {
  private server: Server | null = null;
  private children = new Set<ChildProcess>();

  constructor(
    private readonly device: string,
    private readonly port: number,
  ) {}

  start(): void {
    if (this.server) return;

    this.server = createServer((req, res) => {
      if (!req.url?.startsWith('/preview')) {
        res.writeHead(404).end('not found');
        return;
      }

      const child = spawn('ffmpeg', buildLivePreviewArgs(this.device));
      this.children.add(child);

      // The boundary must match what ffmpeg's mpjpeg muxer emits, or the
      // browser renders nothing and reports no error.
      res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
        'Cache-Control': 'no-store',
      });

      child.stdout.pipe(res);

      // A camera with no signal exits immediately; ending the response is what
      // lets the page show a broken image rather than spinning forever.
      child.on('close', () => {
        this.children.delete(child);
        res.end();
      });

      // Killed when the viewer navigates away, so a closed tab does not leave
      // an ffmpeg decoding a camera nobody is watching.
      res.on('close', () => {
        child.kill('SIGINT');
        this.children.delete(child);
      });
    });

    this.server.listen(this.port, LOOPBACK_ONLY);
  }

  stop(): void {
    for (const child of this.children) child.kill('SIGINT');
    this.children.clear();
    this.server?.close();
    this.server = null;
  }
}
