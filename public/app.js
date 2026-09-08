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
  previewTimer: null,
  preview: null,
  timeline: null,
  audioBySource: new Map(),
  playingSource: null,
};

const $ = (id) => document.getElementById(id);

function show(screen) {
  for (const name of ['new', 'recording', 'review', 'sessions', 'preview']) {
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
      // A dated default beats "Untitled session": several of those in the list
      // are indistinguishable, and the operator names a session precisely when
      // they are least inclined to type.
      body: JSON.stringify({
        title:
          $('session-title').value.trim() ||
          `Recording ${new Date().toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}`,
        tracks,
      }),
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

      // The activity stream is one continuous JSONL file, not segments, so a
      // segment count of 0 would read as "captured nothing" for a track that
      // is working perfectly.
      const amount =
        t.kind === 'metadata'
          ? Number(t.bytes) > 0
            ? 'activity log'
            : '—'
          : `${t.segmentCount || 0}`;

      return `
        <tr>
          <td>${t.kind}</td>
          <td class="src">${t.sourceRef}</td>
          <td>${amount}</td>
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
    ? tracks
        .map((t) =>
          t.kind === 'metadata' ? 'activity log' : `${t.kind} (${t.segmentCount || 0} seg)`,
        )
        .join(', ')
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
          <td>${
            session.startedAt && session.endedAt
              ? hhmmss(new Date(session.endedAt) - new Date(session.startedAt))
              : '—'
          }</td>
          <td><code class="src">${session.s3Prefix || '—'}</code></td>
          <td>${
            session.state === 'stored'
              ? `<button type="button" class="preview-open" data-session="${session.id}" data-title="${session.title}">Preview</button>`
              : ''
          }</td>
        </tr>`,
    )
    .join('');

  // Wired here rather than in boot: the rows are rebuilt on every refresh, so
  // a listener attached once to the original markup would be lost the first
  // time the list reloaded.
  for (const button of document.querySelectorAll('button.preview-open')) {
    button.addEventListener('click', () =>
      openPreview(button.dataset.session, button.dataset.title),
    );
  }
}

// -------------------------------------------------------------------- preview

/**
 * The window-focus palette. Eight distinguishable hues plus one neutral, so a
 * session that touched forty windows still reads as a small number of blocks
 * rather than forty near-identical colours.
 */
const FOCUS_COLOURS = [
  '#4c78a8', '#f58518', '#54a24b', '#e45756',
  '#72b7b2', '#eeca3b', '#b279a2', '#ff9da6',
];
const OTHER_COLOUR = '#9aa0a6';

/** dB at which ffmpeg reports a stream with no signal at all. */
const DIGITAL_SILENCE_DB = -91;

async function openPreview(sessionId, title) {
  state.preview = { sessionId, title };
  $('preview-title').textContent = title || sessionId;
  $('preview-render-note').textContent = 'Loading…';
  $('preview-sources').innerHTML = '';
  $('preview-legend').innerHTML = '';
  // Exactly as specified: no keys/clicks lane, no zero bar, no flat line. A
  // zero would read as "the session was quiet"; the honest statement is that
  // the signal was never captured.
  $('preview-activity-note').textContent =
    'Keystroke and click density not captured — see the tracker defect in TASKS.md.';
  show('preview');
  document.querySelector('nav button[data-screen="preview"]').hidden = false;

  // Fetched in parallel, and the timeline is drawn the moment it arrives. It
  // comes from a text file that needs no rendering, so making the operator
  // wait minutes for the proxy before seeing which windows they were in would
  // be an artificial delay.
  void loadTimeline(sessionId);
  await refreshPreviewStatus(sessionId, true);
}

async function loadTimeline(sessionId) {
  try {
    const timeline = await api(`/api/sessions/${sessionId}/timeline?buckets=1200`);
    state.timeline = timeline;
    drawTimeline(timeline);
  } catch (error) {
    $('preview-legend').textContent = `Activity stream unavailable: ${error.message}`;
  }
}

async function refreshPreviewStatus(sessionId, mayRequest) {
  const status = await api(`/api/sessions/${sessionId}/preview`);
  renderSources(sessionId, status);

  if (status.state === 'ready') {
    clearInterval(state.previewTimer);
    state.previewTimer = null;
    $('preview-render-note').textContent = status.sourcePath
      ? `Proxy rendered from ${status.sourcePath} files.`
      : 'Proxy ready.';
    attachMedia(sessionId, status);
    return;
  }

  if (status.state === 'failed') {
    clearInterval(state.previewTimer);
    state.previewTimer = null;
    $('preview-render-note').textContent = `Render failed: ${status.failureReason || 'no reason reported'}. Reload to retry.`;
    return;
  }

  if (status.failureReason === 'capture_running') {
    $('preview-render-note').textContent = 'Waiting for the current recording to finish.';
  } else if (status.state === 'rendering') {
    // The two paths differ by more than an order of magnitude. A silent
    // thirty-times-longer wait reads as a hang.
    $('preview-render-note').textContent =
      status.sourcePath === 'storage'
        ? 'Fetching 1.6 GB from storage, then rendering — about 20 minutes.'
        : 'Rendering from local files — about 7 minutes.';
  } else {
    $('preview-render-note').textContent = 'Requesting a render…';
  }

  if (mayRequest && status.state === 'pending') {
    // No source argument: one render produces every audio source, so
    // switching source later never queues a second pass over the media.
    await api(`/api/sessions/${sessionId}/preview`, { method: 'POST' });
  }

  if (!state.previewTimer) {
    state.previewTimer = setInterval(() => {
      if (state.preview?.sessionId === sessionId) void refreshPreviewStatus(sessionId, false);
    }, 5000);
  }
}

function attachMedia(sessionId, status) {
  const video = $('preview-video');
  if (video.dataset.sessionId !== sessionId) {
    video.dataset.sessionId = sessionId;
    video.src = `/api/sessions/${sessionId}/preview/media`;
  }

  const holder = $('preview-audio-elements');
  if (holder.dataset.sessionId === sessionId) return;
  holder.dataset.sessionId = sessionId;
  holder.innerHTML = '';
  state.audioBySource.clear();

  // One element per source. The video proxy is silent by construction, so
  // exactly one of these is unmuted and playing at a time -- a browser plays
  // only the first audio track of a <video> and exposes no switcher, which is
  // why the sources are separate files at all.
  for (const source of status.audioSources) {
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.src = `/api/sessions/${sessionId}/preview/audio/${encodeURIComponent(source.sourceRef)}`;
    holder.appendChild(audio);
    state.audioBySource.set(source.sourceRef, audio);
  }

  const selected = status.audioSources.find((s) => s.selected) ?? status.audioSources[0];
  if (selected) playSource(selected.sourceRef);

  for (const event of ['play', 'seeked', 'ratechange']) {
    video.addEventListener(event, syncAudio);
  }
  video.addEventListener('pause', () => {
    for (const audio of state.audioBySource.values()) audio.pause();
  });
  // The real tracks differ in length by tens of milliseconds, so drift is
  // real and accumulates over a long session.
  video.addEventListener('timeupdate', () => {
    const audio = state.audioBySource.get(state.playingSource);
    if (audio && Math.abs(audio.currentTime - video.currentTime) > 0.3) syncAudio();
  });
}

function syncAudio() {
  const video = $('preview-video');
  for (const [sourceRef, audio] of state.audioBySource) {
    if (sourceRef !== state.playingSource) {
      audio.pause();
      continue;
    }
    audio.currentTime = video.currentTime;
    audio.playbackRate = video.playbackRate;
    if (!video.paused) void audio.play().catch(() => undefined);
  }
}

/**
 * Switches which source is audible.
 *
 * Deliberately never touches the video element: swapping source seeks only
 * the audio, so the picture does not stall or restart. That is the whole
 * reason the audio is separate files.
 */
function playSource(sourceRef) {
  state.playingSource = sourceRef;
  syncAudio();
  for (const button of document.querySelectorAll('#preview-sources button')) {
    button.classList.toggle('active', button.dataset.source === sourceRef);
  }
}

function renderSources(sessionId, status) {
  const panel = $('preview-sources');
  if (status.audioSources.length === 0) {
    panel.textContent = 'This session captured no audio.';
    return;
  }

  panel.innerHTML = status.audioSources
    .map((source) => {
      const silent = source.silent || source.maxDb <= DIGITAL_SILENCE_DB;
      const level = silent
        ? 'digital silence — this device was probably not the active input'
        : `peak ${source.maxDb.toFixed(1)} dB, mean ${source.meanDb.toFixed(1)} dB`;
      return `
        <button type="button" class="source" data-source="${source.sourceRef}">
          <span class="src">${source.sourceRef}</span>
          <span class="level">${level}</span>
          ${source.reason ? `<span class="reason">${source.reason}</span>` : ''}
        </button>`;
    })
    .join('');

  // Every source is selectable, including the silent ones: that is how the
  // operator confirms which microphone actually worked. A silent track is not
  // a defect, and the agent correctly reported all of them as available.
  panel.insertAdjacentHTML(
    'beforeend',
    '<p class="note">All sources listed were captured and uploaded successfully. A source recording digital silence is a fact about the microphone, not a fault in the recording.</p>',
  );

  for (const button of panel.querySelectorAll('button.source')) {
    button.addEventListener('click', () => {
      playSource(button.dataset.source);
      // Persisted so reopening the session does not revert to a different
      // microphone than the one the operator settled on.
      void api(`/api/sessions/${sessionId}/preview/source`, {
        method: 'POST',
        body: JSON.stringify({ sourceRef: button.dataset.source }),
      }).catch(() => undefined);
    });
  }
  if (state.playingSource) playSource(state.playingSource);
}

function drawTimeline(timeline) {
  const canvas = $('preview-timeline');
  canvas.width = canvas.clientWidth || 900;
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const focusHeight = 40;
  const gap = 8;
  const mouseTop = focusHeight + gap;
  const mouseHeight = canvas.height - mouseTop;

  ctx.clearRect(0, 0, width, canvas.height);
  if (!timeline || timeline.durationMs <= 0) {
    ctx.fillStyle = '#9aa0a6';
    ctx.fillText('No activity recorded for this session.', 8, 20);
    return;
  }

  const top = timeline.topWindows.slice(0, FOCUS_COLOURS.length);
  const colourOf = (window) => {
    const index = top.findIndex((entry) => entry.window === window);
    return index >= 0 ? FOCUS_COLOURS[index] : OTHER_COLOUR;
  };
  const x = (ms) => (ms / timeline.durationMs) * width;

  for (const interval of timeline.focus) {
    ctx.fillStyle = colourOf(interval.window);
    ctx.fillRect(x(interval.startMs), 0, Math.max(1, x(interval.endMs) - x(interval.startMs)), focusHeight);
  }

  const peak = Math.max(1, ...timeline.buckets.map((b) => b.mouseMovement));
  ctx.fillStyle = '#4c78a8';
  for (const bucket of timeline.buckets) {
    const height = (bucket.mouseMovement / peak) * mouseHeight;
    ctx.fillRect(x(bucket.startMs), mouseTop + (mouseHeight - height), Math.max(1, width / timeline.buckets.length), height);
  }

  $('preview-legend').innerHTML = top
    .map(
      (entry, index) =>
        `<span class="legend"><i style="background:${FOCUS_COLOURS[index]}"></i>${entry.window} · ${hhmmss(entry.totalMs)}</span>`,
    )
    .join('') + '<span class="legend"><i style="background:#4c78a8"></i>mouse movement</span>';

  canvas.onclick = (event) => {
    const rect = canvas.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const video = $('preview-video');
    // Seek the video; the active audio element follows through syncAudio.
    video.currentTime = (ratio * timeline.durationMs) / 1000;
    syncAudio();
  };
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
