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

  it('has a container in the page for the lanes to be written into', () => {
    expect(html).toContain('id="preview-waveforms"');
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
