import type { ChildProcess } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';

export type SpawnFn = (command: string, args: string[]) => ChildProcess;

/**
 * Global input counting on X11, via the XInput2 extension.
 *
 * ## Why this mechanism
 *
 * X11 offers two ways to observe input the user is not directing at you:
 * XRecord and XInput2. This uses XInput2 through `xinput test-xi2 --root`,
 * spawned as a child process, for one reason above all others: **its output
 * cannot express a character.**
 *
 * `xinput test-xi2` prints a raw hardware keycode (`detail: 38`) and nothing
 * else. Turning 38 into the letter `a` needs the X keymap, the active keyboard
 * group, and the modifier state -- an `XkbKeycodeToKeysym` call this process
 * never makes and has no library loaded to make. So the privacy boundary is not
 * a filter applied to sensitive data that arrived; the sensitive data never
 * arrives. Leaking a character from here would mean adding a keymap dependency,
 * writing the lookup, and wiring it in. It cannot happen by forgetting to
 * remove something.
 *
 * ## Why not the alternatives
 *
  * - **`/dev/input` (evdev)**: readable here (this user is in the `input` group),
 *   but wrong on three counts. It is a *stronger* capability than the job
 *   needs -- full key identity, on every seat, including the display manager's
 *   password prompt and other users' VTs, with no notion of which X session is
 *   focused. This host also runs `keyd`, which republishes remapped events on a
 *   virtual device, so a single press appears on both `MX KEYS S` and `keyd
 *   virtual keyboard` and naive counting doubles it. And it needs device
 *   enumeration plus hotplug handling for 21 nodes. Choosing the weaker
 *   mechanism is the point.
 * - **XRecord**: equivalent in privacy terms, but has no packaged CLI here, so
 *   it would mean a native addon -- a compiled dependency in the one process
 *   that must never destabilise an unrepeatable recording.
 * - **A node global-hook library**: every such package resolves keycodes to
 *   characters as its primary feature. Depending on one would put a
 *   character-capable code path inside this process and leave the boundary
 *   resting on our own restraint in calling it.
 *
 * ## What this can and cannot observe
 *
 * Can: that a key was pressed, that a mouse button was pressed, and which
 * modifier keys were held at the time. Session-wide, across every window.
 *
 * Cannot: which character was typed, the text of anything written, the
 * clipboard, or which non-modifier key completed a combination. It also cannot
 * see input while the screen is locked or on another VT, because the X server
 * does not deliver it -- a limitation that happens to be a feature.
 */

/**
 * Modifier keycodes on X11.
 *
 * These are fixed hardware keycodes, identical across keyboard layouts, which
 * is exactly why they can be recognised without consulting a keymap. This table
 * is the *complete* set of keycodes this module attaches any name to; every
 * other keycode is anonymous by construction.
 */
const MODIFIER_KEYCODES = new Map<number, string>([
  [37, 'ctrl'], // Control_L
  [105, 'ctrl'], // Control_R
  [50, 'shift'], // Shift_L
  [62, 'shift'], // Shift_R
  [64, 'alt'], // Alt_L
  [108, 'alt'], // Alt_R / AltGr
  [133, 'super'], // Super_L
  [134, 'super'], // Super_R
]);

/** Stable ordering, so `ctrl+shift+key` never also appears as `shift+ctrl+key`. */
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'super'];

/**
 * The literal that stands in for the key that completed a combination.
 *
 * `ctrl+key`, never `ctrl+s`. Distinguishing a save from a select-all would
 * mean recording which character was pressed, and a hotkey is only in this file
 * at all because "the user held a modifier" is navigational signal. The
 * identity of the other key is content, and content is not recorded.
 */
const OPAQUE_KEY = 'key';

export const XI2_ARGS = ['test-xi2', '--root'];

export type Xi2Line =
  | { kind: 'key' }
  | { kind: 'button' }
  | { kind: 'release' }
  | { kind: 'detail'; code: number }
  | null;

/**
 * Classifies one line of `xinput test-xi2` output.
 *
 * Only *raw press* events add to a count: counting releases too would double
 * every number, and "a key went up" adds nothing an editor can use. A raw
 * release is still recognised, because it is the only thing that may clear a
 * held modifier.
 *
 * Everything else -- including the cooked `EVENT type 2 (KeyPress)` that
 * xinput prints alongside every raw event -- is deliberately unclassified. The
 * cooked events duplicate the raw ones and carry their own `detail:` lines, so
 * acting on them at all is what made every hotkey come out empty on real input.
 */
export function parseXi2Line(line: string): Xi2Line {
  if (line.includes('(RawKeyPress)')) return { kind: 'key' };
  if (line.includes('(RawButtonPress)')) return { kind: 'button' };
  if (line.includes('(RawKeyRelease)')) return { kind: 'release' };

  const detail = line.match(/^\s*detail:\s*(\d+)\s*$/);
  if (detail) return { kind: 'detail', code: Number(detail[1]) };

  return null;
}

export interface InputListenerOptions {
  /** Called once per keypress. The argument is a modifier combination or nothing. */
  onKey: (hotkey?: string) => void;
  onClick: () => void;
  spawnFn?: SpawnFn;
  /** Logged, never thrown: a broken listener must not stop a recording. */
  onError?: (message: string) => void;
}

/**
 * Counts keypresses and clicks for the activity tracker.
 *
 * Failure is always silent-but-logged and always degrades to zero counts. The
 * agent holds the only copy of an unrepeatable recording, so nothing in this
 * file may throw into the capture path: a missing `xinput`, a dead child, or
 * malformed output all end with the counters simply staying at zero.
 */
export class InputListener {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private pending: 'key' | 'button' | 'release' | null = null;
  /** Modifier keycodes currently held down. Identity is discarded on release. */
  private readonly heldModifiers = new Set<number>();
  private stopped = false;
  private readonly spawnFn: SpawnFn;

  constructor(private readonly options: InputListenerOptions) {
    this.spawnFn =
      options.spawnFn ?? ((command, args) => nodeSpawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }));
  }

  start(): void {
    this.stopped = false;
    try {
      const proc = this.spawnFn('xinput', XI2_ARGS);
      this.proc = proc;

      proc.stdout?.setEncoding?.('utf8');
      proc.stdout?.on('data', (chunk: string | Buffer) => this.consume(chunk.toString()));

      // xinput's own diagnostics. Kept out of the counters entirely; it is a
      // separate stream and is never parsed for events.
      proc.stderr?.on('data', (chunk: Buffer) => this.report(`xinput: ${chunk.toString().trim()}`));

      proc.on('error', (error: Error) => {
        this.proc = null;
        this.report(`input listener could not run: ${error.message}`);
      });

      proc.on('exit', (code, signal) => {
        this.proc = null;
        if (!this.stopped) this.report(`input listener exited (code=${code} signal=${signal}); counts will be zero`);
      });
    } catch (error) {
      // `spawn` itself threw -- xinput absent, or no permission. Recording
      // continues; only the counters are lost.
      this.proc = null;
      this.report(`input listener unavailable: ${(error as Error).message}`);
    }
  }

  /**
   * Feeds raw stdout through the line parser.
   *
   * A pipe splits wherever it likes, so the trailing partial line is carried
   * into the next chunk rather than parsed and lost.
   */
  private consume(text: string): void {
    this.buffer += text;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) this.handleLine(line);
  }

  private handleLine(line: string): void {
    const parsed = parseXi2Line(line);
    if (!parsed) return;

    if (parsed.kind === 'key' || parsed.kind === 'button' || parsed.kind === 'release') {
      // The event header arrives before its detail line; remember which.
      this.pending = parsed.kind;
      return;
    }

    // A `detail:` line nobody claimed belongs to a cooked event -- xinput
    // prints `EVENT type 2 (KeyPress)` after every raw one, with its own
    // detail. It is a duplicate of an event already handled, so it must change
    // nothing at all. Treating it as a release is precisely the defect that
    // made every hotkey empty on real input.
    if (this.pending === null) return;

    const kind = this.pending;
    this.pending = null;

    // A key came up: forget it was held. This is the ONLY path that clears a
    // modifier, so a combination cannot be dissolved by a duplicate event.
    if (kind === 'release') {
      this.heldModifiers.delete(parsed.code);
      return;
    }

    if (kind === 'button') {
      this.safely(() => this.options.onClick());
      return;
    }

    const modifier = MODIFIER_KEYCODES.get(parsed.code);
    if (modifier !== undefined) {
      // A modifier press is still a keypress -- it is a count -- but a modifier
      // alone is not a combination, so it reports no hotkey.
      this.heldModifiers.add(parsed.code);
      this.safely(() => this.options.onKey());
      return;
    }

    // A non-modifier key. Its keycode is used for exactly one thing -- deciding
    // it is not a modifier -- and is then dropped. It is never stored, never
    // formatted, and never passed on.
    this.safely(() => this.options.onKey(this.currentHotkey()));
  }

  /**
   * Builds the combination from the modifiers held right now.
   *
   * Returns nothing when no modifier is down, which is the common case: an
   * ordinary keypress contributes only to the count.
   */
  private currentHotkey(): string | undefined {
    if (this.heldModifiers.size === 0) return undefined;

    const names = new Set<string>();
    for (const code of this.heldModifiers) {
      const name = MODIFIER_KEYCODES.get(code);
      if (name) names.add(name);
    }
    if (names.size === 0) return undefined;

    const ordered = MODIFIER_ORDER.filter((name) => names.has(name));
    return `${ordered.join('+')}+${OPAQUE_KEY}`;
  }

  /** A throwing callback must not kill the stdout handler and stop all counting. */
  private safely(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.report(`activity counter threw: ${(error as Error).message}`);
    }
  }

  private report(message: string): void {
    if (this.options.onError) this.options.onError(message);
    else console.error(message);
  }

  isRunning(): boolean {
    return this.proc !== null;
  }

  stop(): void {
    this.stopped = true;
    const proc = this.proc;
    this.proc = null;
    this.heldModifiers.clear();
    this.pending = null;
    this.buffer = '';
    try {
      proc?.kill('SIGTERM');
    } catch {
      // Already gone. Nothing to do, and certainly nothing to throw.
    }
  }
}
