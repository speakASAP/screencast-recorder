import { closedSegments } from './eligibility';

describe('closedSegments', () => {
  it('holds back the highest-numbered segment, which ffmpeg is still writing', () => {
    // Uploading the open segment ships a truncated object that HEAD reports at
    // the wrong size for ever after.
    expect(closedSegments(['seg-00000.mp4', 'seg-00001.mp4', 'seg-00002.mp4'])).toEqual([
      'seg-00000.mp4',
      'seg-00001.mp4',
    ]);
  });

  it('returns nothing for a single segment, because it is still open', () => {
    expect(closedSegments(['seg-00000.mp4'])).toEqual([]);
  });

  it('returns nothing for an empty directory', () => {
    expect(closedSegments([])).toEqual([]);
  });

  it('ignores files that are not segments', () => {
    // events.jsonl and manifest.json travel at Save, not here.
    expect(closedSegments(['events.jsonl', 'seg-00000.m4a', 'seg-00001.m4a'])).toEqual([
      'seg-00000.m4a',
    ]);
  });

  it('orders by segment number, not by string sort of mixed widths', () => {
    // Zero-padding makes lexical order chronological today, but a rollover past
    // 99999 would break that silently.
    expect(closedSegments(['seg-00010.mp4', 'seg-00002.mp4', 'seg-00001.mp4'])).toEqual([
      'seg-00001.mp4',
      'seg-00002.mp4',
    ]);
  });
});
