import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Structural checks on the console's client script.
 *
 * The Preview button shipped rendered but dead: `loadSessions` wrote the
 * markup and nothing ever attached a click handler, so 293 passing tests said
 * the feature worked while clicking it did nothing at all. The client script
 * has no test coverage of its own — it is plain browser JavaScript in a
 * node-environment suite — so these assert the one property whose absence
 * produced that symptom: every button the script generates has a handler
 * bound to it.
 *
 * This is not a substitute for opening the page. It is the cheapest thing
 * that would have caught a control that does nothing.
 */
const app = readFileSync(join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
const html = readFileSync(join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');

describe('every generated control is wired', () => {
  // Buttons written into innerHTML carry a class; that class is how the
  // handler finds them again after each re-render.
  const generatedClasses = [...app.matchAll(/<button[^>]*class="([a-z-]+)"/g)].map((m) => m[1]);

  it('finds the generated buttons at all, so this test cannot silently pass', () => {
    expect(generatedClasses.length).toBeGreaterThan(0);
    expect(generatedClasses).toContain('preview-open');
  });

  it.each([...new Set(generatedClasses)])(
    'binds a click handler for generated button .%s',
    (className) => {
      const selector = new RegExp(`querySelectorAll\\('button\\.${className}'\\)`);
      expect(app).toMatch(selector);
    },
  );

  it('re-binds inside the function that regenerates the rows', () => {
    // A handler attached once at boot is lost the first time loadSessions
    // rewrites the table, which is a slower version of the same bug.
    const loadSessions = app.slice(app.indexOf('async function loadSessions'));
    const body = loadSessions.slice(0, loadSessions.indexOf('\n}\n'));
    expect(body).toMatch(/querySelectorAll\('button\.preview-open'\)/);
  });
});

describe('every element the script addresses by id exists in the page', () => {
  const ids = [...app.matchAll(/\$\('([a-z-]+)'\)/g)].map((m) => m[1]);

  it.each([...new Set(ids)])('index.html declares id="%s"', (id) => {
    expect(html).toContain(`id="${id}"`);
  });
});

describe('the waveform lanes are wired to the shared playhead', () => {
  it('gives every lane a click handler', () => {
    // The failure this guards is the same one that shipped before: markup
    // rendered, nothing bound, and a lane that looks interactive but is not.
    expect(app).toMatch(/canvas\.onclick\s*=/);
  });

  it('seeks through one path from both the lanes and the activity canvas', () => {
    // Two seek implementations would drift: clicking a waveform and clicking
    // the activity timeline would land on different instants.
    expect(app).toContain('function seekAll(');
    expect([...app.matchAll(/seekAll\(/g)]).toHaveLength(3);
  });

  it('has a container in the page for the source rows to be written into', () => {
    // Lanes live inside the source rows now: one section, one list of
    // devices, each with the button that selects it beside its own waveform.
    expect(html).toContain('id="preview-sources"');
  });

  it('paints each lane into the row its source button is in', () => {
    expect(app).toMatch(/canvas class="wave-canvas"[^>]*data-source-ref=/);
    expect(app).toContain('canvas.wave-canvas[data-source-ref=');
  });

  it('keeps a lane click from also selecting the source', () => {
    // The lane sits inside the row: without stopPropagation, seeking would
    // also switch the audible source and POST a preference nobody expressed.
    // Anchored inside drawWaveforms: the activity timeline assigns
    // canvas.onclick too, and it is not nested in a button, so slicing from
    // the first occurrence would assert against the wrong handler.
    const lanes = app.slice(app.indexOf('async function drawWaveforms'));
    const handler = lanes.slice(lanes.indexOf('canvas.onclick'));
    expect(handler.slice(0, handler.indexOf('};'))).toContain('stopPropagation');
  });

  it('fetches precomputed peaks rather than decoding audio in the browser', () => {
    // Decoding a four-hour proxy client-side is the thing this design avoids.
    expect(app).toContain('/preview/peaks/');
    expect(app).not.toContain('AudioContext');
  });
});

describe('the camera check is wired', () => {
  it('binds both puller buttons', () => {
    // These are hand-written in index.html rather than generated, so the
    // generated-button sweep above does not cover them.
    expect(app).toContain("$('puller-start').addEventListener");
    expect(app).toContain("$('puller-stop').addEventListener");
  });

  it('has the elements those handlers address', () => {
    for (const id of ['puller-status', 'puller-start', 'puller-stop', 'camera-preview']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('re-checks the camera when the source selection changes', () => {
    // Ticking the iPhone is the moment the check becomes relevant; without
    // this the panel never appears.
    expect(app).toContain('updateCameraCheck');
  });

  it('points the preview at the agent loopback port, never a public host', () => {
    // The stream is a live camera with no authentication in front of it. It
    // must never be fetched from anything but this host.
    expect(app).toContain('127.0.0.1:${LIVE_PREVIEW_PORT}');
    expect(app).not.toMatch(/preview.*0\.0\.0\.0/);
  });
});

describe('the preview releases the camera before recording', () => {
  it('stops the preview inside startSession', () => {
    // v4l2loopback with exclusive_caps admits ONE reader. Leaving the preview
    // attached made the capture fail with "Device or resource busy", and the
    // session sat in `preparing` with every track pending.
    const start = app.slice(app.indexOf('async function startSession()'));
    expect(start.slice(0, 600)).toContain('stopCameraPreview()');
  });
});

describe('a session stuck in preparing can be abandoned', () => {
  it('binds the abandon button', () => {
    // Stop is legal only from `recording`, so a session stuck in `preparing`
    // had no exit: the operator pressed Stop, nothing happened, and the only
    // way out was a database update.
    expect(app).toContain("$('abandon').addEventListener");
    expect(html).toContain('id="abandon"');
  });

  it('discards rather than stopping, because stopping is not a legal transition', () => {
    const fn = app.slice(app.indexOf('async function abandonSession()'));
    expect(fn.slice(0, 500)).toContain('/discard');
  });

  it('shows abandon only while preparing, and hides Stop then', () => {
    // Offering a control that cannot work is what produced the original
    // report: "I clicked Stop twice and nothing happened."
    expect(app).toContain("session.state === 'preparing'");
    expect(app).toContain("$('stop').hidden = stuck");
  });
});

describe('a session resumed while uploading shows what it is uploading', () => {
  const fn = app.slice(app.indexOf('async function resumeActiveSession()'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  it('fills the review fields on the uploading branch, not only the review one', () => {
    // Reloading during an upload routed straight to `show('review')` without
    // ever calling enterReview, so Title, Duration, Tracks and Total size kept
    // the em-dash defaults from the markup. The screen reported a live upload
    // of a session it could not name.
    const uploading = body.slice(body.indexOf("session.state === 'uploading'"));
    expect(uploading).toContain('enterReview(');
  });
});

describe('the upload poll can end without the session reaching a terminal state', () => {
  const fn = app.slice(app.indexOf('function followUpload()'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  it('stops polling when progress stops advancing', () => {
    // The poll cleared its interval only on `stored` or `failed`. A save whose
    // upload-complete call never landed leaves the session in `uploading` for
    // ever, and the console polled every two seconds against a state nothing
    // would advance -- "0 of 5 tracks verified", indefinitely.
    expect(body).toContain('stallMs');
    expect(body).toMatch(/clearInterval\(state\.uploadTimer\)/);
  });

  it('says the upload has stalled rather than continuing to claim progress', () => {
    expect(body).toMatch(/stalled/i);
  });

  it('treats an unexpected state as terminal instead of polling on', () => {
    // `discarded` is reachable from `uploading` and is not `stored` or
    // `failed`; without this the poll outlives the session.
    expect(body).toContain("session.state !== 'uploading'");
  });
});

describe('the review lede reflects what has actually been uploaded', () => {
  it('is addressable, so it cannot keep claiming nothing was uploaded', () => {
    // Hardcoded as "Recording finished. Nothing has been uploaded yet." it sat
    // directly above a running progress bar. Continuous upload makes it wrong
    // from the moment recording starts.
    expect(html).toContain('id="review-lede"');
    expect(app).toContain("$('review-lede')");
  });
});
