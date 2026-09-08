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
