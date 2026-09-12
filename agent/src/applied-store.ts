export interface AppliedStoreDeps {
  read(): Promise<string | null>;
  write(contents: string): Promise<void>;
}

/**
 * How many applied command ids are kept.
 *
 * Only has to outlast the API's redelivery lease, which is 30 seconds, so this
 * is generous by orders of magnitude. Bounded because the file is rewritten on
 * every command for the life of the machine.
 */
export const APPLIED_RETAINED = 200;

/**
 * Remembers which commands this agent already applied, across restarts.
 *
 * The agent has always refused a redelivered command_id, but the set lived in
 * memory only, which was sound while the API retired a command on handout:
 * nothing was ever redelivered, so nothing needed remembering. Now that an
 * unacknowledged command is offered again once its lease expires, the set has
 * to survive the restart -- because the restart is precisely what causes the
 * redelivery. Without this, a redelivered `start` spawns a second ffmpeg tree
 * writing into the same directory and interleaves two recordings.
 *
 * Every method swallows its own I/O errors, like `PendingStore`: this is called
 * from the command path, which must not fail because a disk did.
 */
export class AppliedStore {
  constructor(private readonly deps: AppliedStoreDeps) {}

  async load(): Promise<string[]> {
    let raw: string | null;
    try {
      raw = await this.deps.read();
    } catch {
      return [];
    }
    if (!raw) return [];

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      if (!parsed.every((id) => typeof id === 'string')) return [];
      return parsed as string[];
    } catch {
      // A crash mid-write leaves a partial file. Starting with an empty set
      // beats refusing to start.
      return [];
    }
  }

  async save(ids: string[]): Promise<void> {
    try {
      await this.deps.write(JSON.stringify(ids.slice(-APPLIED_RETAINED)));
    } catch {
      // Nothing to do and nowhere to report it. Never rethrow: this is called
      // from the command path.
    }
  }
}
