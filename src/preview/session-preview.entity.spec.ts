import { PreviewState, isLegalPreviewTransition } from './session-preview.entity';

describe('preview transitions', () => {
  it('allows the render path and the retry of a failure', () => {
    expect(isLegalPreviewTransition(PreviewState.Pending, PreviewState.Rendering)).toBe(true);
    expect(isLegalPreviewTransition(PreviewState.Rendering, PreviewState.Ready)).toBe(true);
    expect(isLegalPreviewTransition(PreviewState.Rendering, PreviewState.Failed)).toBe(true);
    expect(isLegalPreviewTransition(PreviewState.Failed, PreviewState.Rendering)).toBe(true);
  });

  it('allows a deferred render to return to pending as its retry path', () => {
    expect(isLegalPreviewTransition(PreviewState.Rendering, PreviewState.Pending)).toBe(true);
  });

  it('refuses to move on from a ready preview', () => {
    // A ready proxy is reusable; re-rendering it would be wasted GPU time and
    // would swap the object out from under a player that is mid-seek.
    expect(isLegalPreviewTransition(PreviewState.Ready, PreviewState.Rendering)).toBe(false);
  });
});
