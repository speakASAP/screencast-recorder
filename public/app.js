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
    ...options,
  });
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

  // A rough figure, but the useful one: it answers "will this fill the disk?".
  const screens = chosen.filter((s) => s.kind === 'screen').length;
  const fps = Number($('preset').value);
  const gbPerHour = screens * (fps / 15) * 10;
  $('estimate').textContent = screens
    ? `Rough estimate: ${gbPerHour.toFixed(0)} GB per hour for ${screens} screen track(s) at ${fps} fps.`
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
  if (session.state === 'review') enterReview(session);
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
}

async function saveSession() {
  await api(`/api/sessions/${state.sessionId}/save`, { method: 'POST' });
  await loadSessions();
  show('sessions');
}

async function discardSession() {
  if (!confirm('Discard this recording? The local files will be deleted and nothing uploaded.')) {
    return;
  }
  await api(`/api/sessions/${state.sessionId}/discard`, { method: 'POST' });
  await loadSessions();
  show('sessions');
}

// ------------------------------------------------------------------- sessions

async function loadSessions() {
  const rows = await api('/api/sessions');
  $('session-table').querySelector('tbody').innerHTML = rows
    .map(
      (session) => `
        <tr>
          <td>${session.title}</td>
          <td>${session.state}</td>
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
  });
}

$('start').addEventListener('click', startSession);
$('stop').addEventListener('click', stopSession);
$('save').addEventListener('click', saveSession);
$('discard').addEventListener('click', discardSession);
$('preset').addEventListener('change', updateStartButton);

loadAgents();
