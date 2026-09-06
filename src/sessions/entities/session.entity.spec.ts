import { SessionState, isLegalTransition } from './session.entity';

describe('session state machine', () => {
  it('allows the happy path', () => {
    expect(isLegalTransition(SessionState.Preparing, SessionState.Recording)).toBe(true);
    expect(isLegalTransition(SessionState.Recording, SessionState.Stopping)).toBe(true);
    expect(isLegalTransition(SessionState.Stopping, SessionState.Review)).toBe(true);
    expect(isLegalTransition(SessionState.Review, SessionState.Uploading)).toBe(true);
    expect(isLegalTransition(SessionState.Uploading, SessionState.Stored)).toBe(true);
  });

  it('refuses to skip the review gate', () => {
    // Nothing may reach S3 without the operator's explicit Save.
    expect(isLegalTransition(SessionState.Recording, SessionState.Uploading)).toBe(false);
    expect(isLegalTransition(SessionState.Stopping, SessionState.Stored)).toBe(false);
    expect(isLegalTransition(SessionState.Recording, SessionState.Stored)).toBe(false);
  });

  it('treats stored and discarded as terminal', () => {
    expect(isLegalTransition(SessionState.Stored, SessionState.Recording)).toBe(false);
    expect(isLegalTransition(SessionState.Stored, SessionState.Uploading)).toBe(false);
    expect(isLegalTransition(SessionState.Discarded, SessionState.Uploading)).toBe(false);
  });

  it('allows failure from any live state', () => {
    expect(isLegalTransition(SessionState.Preparing, SessionState.Failed)).toBe(true);
    expect(isLegalTransition(SessionState.Recording, SessionState.Failed)).toBe(true);
    expect(isLegalTransition(SessionState.Stopping, SessionState.Failed)).toBe(true);
    expect(isLegalTransition(SessionState.Uploading, SessionState.Failed)).toBe(true);
  });

  it('allows discarding from review, so a bad take costs nothing', () => {
    expect(isLegalTransition(SessionState.Review, SessionState.Discarded)).toBe(true);
  });
});
