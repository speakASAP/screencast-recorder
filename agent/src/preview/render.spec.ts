import {
  buildAudioProxyArgs,
  buildConcatList,
  buildVideoProxyArgs,
  buildVolumedetectArgs,
} from './render';

describe('buildVideoProxyArgs', () => {
  const args = buildVideoProxyArgs('/v.txt', '/out.mp4');

  it('puts moov at the front, which is what makes seeking work', () => {
    // Without faststart the browser must download the whole file before it
    // can show a frame or seek -- exactly the trap the raw segments fall into.
    expect(args).toContain('-movflags');
    expect(args).toContain('+faststart');
  });

  it('scales to 960x540 at 10fps, legible enough to find a moment', () => {
    expect(args.join(' ')).toContain('scale=960:540');
    expect(args).toContain('-r');
    expect(args).toContain('10');
  });

  it('uses the VAAPI encoder on the render node', () => {
    expect(args).toContain('h264_vaapi');
    expect(args).toContain('/dev/dri/renderD128');
  });

  it('carries no audio stream at all', () => {
    // Audio lives in separate per-source files. Muxing even one stream here
    // would make that source the only reachable one, because a browser plays
    // only the first audio track of a <video> and exposes no switcher.
    expect(args).toContain('-an');
    expect(args).not.toContain('-c:a');
  });

  it('reads its inputs through the concat demuxer, never a shell glob', () => {
    expect(args.join(' ')).toContain('-f concat -safe 0 -i /v.txt');
  });
});

describe('buildAudioProxyArgs', () => {
  const args = buildAudioProxyArgs('/a.txt', '/out.m4a');

  it('encodes speech at 24k mono 22.05kHz, intelligible rather than pretty', () => {
    // Three tracks at 64k would outweigh the video four to one. This is a
    // preview for judging what was captured, not a listening copy.
    expect(args).toContain('24k');
    expect(args.join(' ')).toContain('-ac 1');
    expect(args).toContain('22050');
  });

  it('carries no video stream', () => {
    expect(args).toContain('-vn');
  });

  it('is faststart too, so seeking the audio does not download it whole', () => {
    expect(args).toContain('+faststart');
  });
});

describe('buildConcatList', () => {
  it('emits one ffmpeg concat entry per segment', () => {
    expect(buildConcatList(['/a/seg-00000.mp4', '/a/seg-00001.mp4'])).toBe(
      "file '/a/seg-00000.mp4'\nfile '/a/seg-00001.mp4'\n",
    );
  });

  it("escapes a quote in a path rather than breaking out of the entry", () => {
    // Paths here are agent-generated, so this is depth rather than a live
    // hole -- but a concat list is read as a small script by ffmpeg, and a
    // stray quote would silently truncate the render to whatever parsed.
    expect(buildConcatList(["/a/it's/seg-0.mp4"])).toBe("file '/a/it'\\''s/seg-0.mp4'\n");
  });
});

describe('buildVolumedetectArgs', () => {
  it('measures a source without writing any output file', () => {
    const args = buildVolumedetectArgs('/a.txt');
    expect(args).toContain('volumedetect');
    expect(args.slice(-1)[0]).toBe('-');
    expect(args).toContain('null');
  });

  it('keeps ffmpeg at info level, because volumedetect reports on stderr there', () => {
    // volumedetect writes mean_volume/max_volume at info. Quietening ffmpeg
    // would make every source measure as unparseable, and parseVolumedetect
    // raises on that rather than reporting silence.
    expect(buildVolumedetectArgs('/a.txt').join(' ')).toContain('-v info');
  });
});
