'use strict';

/**
 * Operator console.
 *
 * Deliberately framework-free: four screens polling two endpoints do not
 * justify a build pipeline, and a plain script stays readable to whoever
 * debugs a recording that went wrong at 2am.
 */

const state = {
  sessionId: null,
  startedAt: null,
  pollTimer: null,
  elapsedTimer: null,
  uploadTimer: null,
  sessionsTimer: null,
};

const $ = (id) => document.getElementById(id);

function show(screen) {
  for (const name of ['new', 'recording', 'review', 'sessions']) {
    $(`screen-${name}`).hidden = name !== screen;
  }
  for (const button of document.querySelectorAll('nav button')) {
    button.classList.toggle('active', button.dataset.screen === screen);
  }
}

function bytes(n) {
  const value = Number(n || 0);
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = value / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function hhmmss(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    // The session is an HTTP-only cookie; page script never holds the token.
    credentials: 'same-origin',
    ...options,
  });

  // An expired session should send the operator to sign in, not surface as a
  // confusing error on every panel.
  if (response.status === 401) {
    location.href = '/auth/login';
    throw new Error('signing in');
  }

  if (!response.ok) {
    let detail = `${response.status}`;
    try {
      const body = await response.json();
      if (body && body.message) detail = body.message;
    } catch {
      /* a non-JSON error body is still just a status */
    }
    throw new Error(detail);
  }
  return response.status === 204 ? null : response.json();
}

// ---------------------------------------------------------------- new session

async function loadAgents() {
  const container = $('agents');
  let agents;
  try {
    agents = await api('/api/ui/agents');
  } catch (error) {
    container.innerHTML = `<p class="error">Could not load agents: ${error.message}</p>`;
    return;
  }

  if (agents.length === 0) {
    container.innerHTML =
      '<p class="muted">No agents have enrolled yet. Start the recording agent on a machine.</p>';
    return;
  }

  container.innerHTML = agents
    .map((agent) => {
      const sources = agent.sources
        .map(
          (source) => `
          <label class="source">
            <input type="checkbox" data-agent="${agent.id}" data-kind="${source.kind}"
                   value="${source.id}" ${agent.online ? '' : 'disabled'}
                   ${source.kind !== 'webcam' ? 'checked' : ''} />
            <span>${source.label}</span>
            <em>${source.kind}</em>
          </label>`,
        )
        .join('');

      // Absent hardware is shown, disabled, with the reason. Hiding it would
      // read as a missing feature rather than a missing device.
      const missing = agent.unavailable
        .map(
          (item) => `
          <label class="source disabled">
            <input type="checkbox" disabled />
            <span>${item.kind}</span>
            <em>${item.reason}</em>
          </label>`,
        )
        .join('');

      return `
        <fieldset class="agent">
          <legend>
            ${agent.hostname}
            <span class="${agent.online ? 'online' : 'offline'}">
              ${agent.online ? 'online' : 'offline'}
            </span>
          </legend>
          ${sources}${missing}
          <p class="muted">
            ${agent.freeDiskBytes ? `Free disk: ${bytes(agent.freeDiskBytes)}` : ''}
            ${agent.encoders.length ? ` · Encoders: ${agent.encoders.join(', ')}` : ''}
          </p>
        </fieldset>`;
    })
    .join('');

  container.addEventListener('change', updateStartButton);
  updateStartButton();
}

function selectedSources() {
  return [...document.querySelectorAll('#agents input[type=checkbox]:checked:not(:disabled)')].map(
    (box) => ({
      agent_id: box.dataset.agent,
      kind: box.dataset.kind,
      source_ref: box.value,
    }),
  );
}

function updateStartButton() {
  const chosen = selectedSources();
  $('start').disabled = chosen.length === 0;

  // Measured on a 4K VAAPI capture of near-static screen content: ~1.4 GB/hour
  // per screen at 15 fps. Motion raises it sharply, so this is a floor rather
  // than a promise, and it is labelled as such.
  const screens = chosen.filter((s) => s.kind === 'screen').length;
  const fps = Number($('preset').value);
  const gbPerHour = screens * (fps / 15) * 1.4;
  $('estimate').textContent = screens
    ? `About ${gbPerHour.toFixed(1)} GB per hour for ${screens} screen track(s) at ${fps} fps, ` +
      'for mostly static content. Video playback on screen can multiply this.'
    : '';
}

async function startSession() {
  $('new-error').hidden = true;
  const fps = Number($('preset').value);

  const tracks = selectedSources().map((source) => ({
    ...source,
    ...(source.kind === 'screen' ? { codec: 'h264_vaapi', fps } : {}),
    ...(source.kind === 'audio' ? { codec: 'aac', bitrate_kbps: 192 } : {}),
  }));

  // The activity stream is what makes later editing possible, so it is added
  // for every participating agent rather than offered as a choice.
  for (const agentId of [...new Set(tracks.map((t) => t.agent_id))]) {
    tracks.push({ agent_id: agentId, kind: 'metadata', source_ref: 'activity', sample_hz: 5 });
  }

  try {
    const session = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: $('session-title').value || 'Untitled session', tracks }),
    });
    state.sessionId = session.id;
    state.startedAt = Date.now();
    enterRecording();
  } catch (error) {
    $('new-error').textContent = `Could not start: ${error.message}`;
    $('new-error').hidden = false;
  }
}

// ------------------------------------------------------------------ recording

function enterRecording() {
  document.querySelector('[data-screen="recording"]').hidden = false;
  show('recording');
  state.pollTimer = setInterval(pollSession, 2000);
  state.elapsedTimer = setInterval(() => {
    $('elapsed').textContent = hhmmss(Date.now() - state.startedAt);
  }, 1000);
  pollSession();
}

async function pollSession() {
  if (!state.sessionId) return;
  let session;
  try {
    session = await api(`/api/sessions/${state.sessionId}`);
  } catch {
    // The controller being unreachable does not stop the recording: the agent
    // keeps capturing locally. Say so rather than implying data loss.
    $('rec-state').textContent = 'controller unreachable — capture continues locally';
    return;
  }

  $('rec-state').textContent = session.state;
  renderTracks(session);

  const p = session.progress || {};
  $('free-disk').textContent = p.freeDiskBytes ? bytes(p.freeDiskBytes) : '—';
  $('active-window').textContent = p.activeWindow || '—';

  if (session.state === 'review') enterReview(session);
}

/** Fills the per-track table so a running session shows visible movement. */
function renderTracks(session) {
  const rows = (session.tracks || [])
    .map((t) => {
      const status = t.degraded
        ? '<span class="bad">degraded</span>'
        : t.uploadState === 'verified'
          ? '<span class="ok">verified</span>'
          : session.state === 'recording'
            ? 'recording'
            : t.uploadState || '—';
      return `
        <tr>
          <td>${t.kind}</td>
          <td class="src">${t.sourceRef}</td>
          <td>${t.segmentCount || 0}</td>
          <td>${bytes(t.bytes)}</td>
          <td>${status}</td>
        </tr>`;
    })
    .join('');
  $('track-table').querySelector('tbody').innerHTML =
    rows || '<tr><td colspan="5" class="muted">waiting for the first segment…</td></tr>';
}

async function stopSession() {
  $('stop').disabled = true;
  try {
    await api(`/api/sessions/${state.sessionId}/stop`, { method: 'POST' });
  } finally {
    $('stop').disabled = false;
  }
}

// --------------------------------------------------------------------- review

function enterReview(session) {
  clearInterval(state.pollTimer);
  clearInterval(state.elapsedTimer);
  document.querySelector('[data-screen="review"]').hidden = false;
  show('review');

  $('rev-title').textContent = session.title;
  $('rev-duration').textContent = session.endedAt
    ? hhmmss(new Date(session.endedAt) - new Date(session.startedAt))
    : '—';

  const tracks = session.tracks || [];
  $('rev-tracks').textContent = tracks.length
    ? tracks.map((t) => `${t.kind} (${t.segmentCount || 0} seg)`).join(', ')
    : '—';
  $('rev-size').textContent = bytes(
    tracks.reduce((n, t) => n + Number(t.bytes || 0), 0),
  );
}

async function saveSession() {
  // Disabled immediately: the first click took a moment with no feedback, so
  // it read as ignored and invited a second click on a session already saving.
  $('save').disabled = true;
  $('discard').disabled = true;
  $('upload-progress').hidden = false;
  $('upload-note').textContent = 'Uploading…';

  try {
    await api(`/api/sessions/${state.sessionId}/save`, { method: 'POST' });
  } catch (error) {
    $('upload-note').textContent = `Could not start the upload: ${error.message}`;
    $('save').disabled = false;
    $('discard').disabled = false;
    return;
  }

  followUpload();
}

/**
 * Polls until the session is stored, showing what has been verified so far.
 *
 * Without this the operator sees "uploading" and no movement, cannot tell a
 * slow upload from a stuck one, and has to reload to discover it finished.
 */
function followUpload() {
  clearInterval(state.uploadTimer);

  state.uploadTimer = setInterval(async () => {
    let session;
    try {
      session = await api(`/api/sessions/${state.sessionId}`);
    } catch {
      $('upload-note').textContent = 'Controller unreachable — the upload continues.';
      return;
    }

    const p = session.progress || {};
    const done = p.uploaded || 0;
    const total = p.total || 0;
    const pct = total ? Math.round((done / total) * 100) : 0;

    $('upload-bar').style.width = `${pct}%`;
    $('upload-count').textContent = `${done} of ${total} tracks verified`;
    renderTracks(session);

    if (session.state === 'stored') {
      clearInterval(state.uploadTimer);
      $('upload-bar').style.width = '100%';
      $('upload-note').textContent =
        'Stored and verified. Local files are kept until you have previewed it.';
      $('upload-count').textContent = `${total} of ${total} tracks verified`;
      setTimeout(async () => {
        await loadSessions();
        show('sessions');
      }, 1500);
    } else if (session.state === 'failed') {
      clearInterval(state.uploadTimer);
      $('upload-note').textContent =
        `Upload failed: ${session.failureReason || 'unknown reason'}. Local files are untouched.`;
      $('save').disabled = false;
    }
  }, 2000);
}

async function discardSession() {
  if (!confirm('Discard this recording? The local files will be deleted and nothing uploaded.')) {
    return;
  }
  $('save').disabled = true;
  $('discard').disabled = true;
  await api(`/api/sessions/${state.sessionId}/discard`, { method: 'POST' });
  await loadSessions();
  show('sessions');
}

// ------------------------------------------------------------------- sessions

async function loadSessions() {
  const rows = await api('/api/sessions');

  // Refresh while any session is still moving, so the list does not sit on a
  // stale "uploading" that has actually finished.
  const inFlight = rows.some((r) => ['uploading', 'recording', 'stopping'].includes(r.state));
  clearInterval(state.sessionsTimer);
  if (inFlight) state.sessionsTimer = setInterval(() => void loadSessions(), 3000);
  $('session-table').querySelector('tbody').innerHTML = rows
    .map(
      (session) => `
        <tr>
          <td>${session.title}</td>
          <td><span class="state state-${session.state}">${session.state}</span></td>
          <td>${session.startedAt ? new Date(session.startedAt).toLocaleString() : '—'}</td>
          <td><code>${session.s3Prefix || '—'}</code></td>
        </tr>`,
    )
    .join('');
}

// ----------------------------------------------------------------------- boot

for (const button of document.querySelectorAll('nav button')) {
  button.addEventListener('click', () => {
    show(button.dataset.screen);
    if (button.dataset.screen === 'sessions') loadSessions();
    if (button.dataset.screen === 'new') loadAgents();
void resumeActiveSession();
  });
}

/**
 * Reattaches to a session that is still live after a reload.
 *
 * Without this a reload during a recording showed the "new session" form, which
 * reads as though the recording was lost -- it was not, the agent keeps
 * capturing regardless, but the console gave no way back to it.
 */
async function resumeActiveSession() {
  let rows;
  try {
    rows = await api('/api/sessions');
  } catch {
    return;
  }

  const live = rows.find((r) => ['recording', 'stopping'].includes(r.state));
  const reviewing = rows.find((r) => r.state === 'review');
  const uploading = rows.find((r) => r.state === 'uploading');
  const session = live || reviewing || uploading;
  if (!session) return;

  state.sessionId = session.id;
  state.startedAt = session.startedAt ? new Date(session.startedAt).getTime() : Date.now();

  if (session.state === 'review') {
    document.querySelector('[data-screen="review"]').hidden = false;
    enterReview(await api(`/api/sessions/${session.id}`));
  } else if (session.state === 'uploading') {
    document.querySelector('[data-screen="review"]').hidden = false;
    show('review');
    $('save').disabled = true;
    $('discard').disabled = true;
    $('upload-progress').hidden = false;
    $('upload-note').textContent = 'Uploading…';
    followUpload();
  } else {
    enterRecording();
  }
}

// Show who is signed in, so a shared screen makes the account obvious.
api('/auth/me')
  .then((me) => {
    if (me && me.email) $('whoami').textContent = me.email;
  })
  .catch(() => undefined);

$('start').addEventListener('click', startSession);
$('stop').addEventListener('click', stopSession);
$('save').addEventListener('click', saveSession);
$('discard').addEventListener('click', discardSession);
$('preset').addEventListener('change', updateStartButton);

loadAgents();
void resumeActiveSession();
