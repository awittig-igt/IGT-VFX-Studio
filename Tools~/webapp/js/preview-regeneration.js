// Shared by the gallery and full viewer. Keep job feedback visible while browsing.
(() => {
  let active = null;
  const storageKey = 'findfx-preview-regeneration';
  let panel;
  function setBusy(busy) {
    document.querySelectorAll('#side-preview-send-unity, [data-send-index]').forEach(button => {
      button.disabled = busy;
      const message = button.dataset?.effectId === active?.effectId
        ? 'Generating Unity Preview…'
        : 'Another effect is currently generating';
      button.textContent = busy ? message : 'Regenerate Unity Preview';
      button.title = busy ? message : 'Regenerate the Unity capture GIF without changing the effect package';
    });
    if (panel) panel.querySelector('button').hidden = busy;
  }
  window.refreshPreviewRegenerationButtons = () => setBusy(Boolean(active));
  function show(message, progress, failed = false) {
    if (!panel) {
      panel = document.createElement('section');
      panel.className = 'preview-job-status';
      panel.setAttribute('aria-label', 'Unity preview generation');
      panel.innerHTML = '<strong></strong><p role="status" aria-live="polite"></p><progress max="100"></progress><a href="/api/project-extraction-log?download=1" target="_blank" rel="noopener">View generation logs</a><button type="button" class="btn-secondary btn-sm">Dismiss</button>';
      panel.querySelector('button').onclick = () => { panel.hidden = true; };
      document.body.append(panel);
    }
    panel.hidden = false;
    panel.querySelector('button').hidden = Boolean(active);
    panel.classList.toggle('failed', failed);
    panel.querySelector('strong').textContent = active?.name || 'Unity preview';
    panel.querySelector('p').textContent = message;
    const bar = panel.querySelector('progress');
    if (progress == null) bar.removeAttribute('value');
    else bar.value = progress;
  }
  async function json(url, options = {}) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok === false) throw new Error(body?.error || `Request failed (${response.status}). Restart FindFX if its server needs updating.`);
    if (!body) throw new Error('The server returned an unreadable status.');
    return body;
  }
  function save(job) {
    try {
      if (job) sessionStorage.setItem(storageKey, JSON.stringify(job));
      else sessionStorage.removeItem(storageKey);
    } catch { /* Feedback still works when storage is unavailable. */ }
  }
  async function monitor() {
    let failures = 0;
    try {
      while (Date.now() - active.startedAt < 30 * 60 * 1000) {
        let job;
        try {
          job = await json('/api/project-extraction-job');
          failures = 0;
        } catch (error) {
          if (++failures >= 5) throw error;
          show(`Reconnecting to generation status: ${error.message}`, null);
          await new Promise(resolve => setTimeout(resolve, 1500));
          continue;
        }
        if (!job.logPath?.includes(active.jobId)) throw new Error('Another generation job replaced this status. Check the library for the completed preview.');
        show(`${job.phase || 'queued'}: ${job.message || 'Waiting for Unity…'}`, job.progress);
        if (job.state === 'failed') throw new Error(job.message || 'Unity preview generation failed.');
        if (job.state === 'complete') {
          const manifest = await json('/local/manifest.json');
          const effect = (manifest.effects || []).find(effect => effect.id === active.effectId);
          if (!effect?.files?.thumbnail) throw new Error('Generation finished, but the updated preview was not found in the library.');
          document.dispatchEvent(new CustomEvent('preview-regenerated', { detail: { effect } }));
          show('Complete — the regenerated Unity preview is now displayed.', 100);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      throw new Error('Still waiting after 30 minutes. The Unity job may still be running; check the generation logs.');
    } catch (error) {
      show(error.message, null, true);
    } finally {
      active = null;
      setBusy(false);
      save(null);
    }
  }
  window.regenerateUnityPreview = async (effect, source) => {
    if (active) { show('A preview is already generating. Wait for it to finish before starting another.', null); return; }
    if (source !== 'local') { show('Preview regeneration requires an effect in the local FindFX library.', null, true); return; }
    active = { effectId: effect.id, name: effect.name, startedAt: Date.now() };
    setBusy(true);
    show('Queuing preview generation…', 0);
    try {
      const result = await json('/api/regenerate-preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ effectId: effect.id })
      });
      active.jobId = result.jobId;
      save(active);
      await monitor();
    } catch (error) {
      show(error.message, null, true);
      active = null;
      setBusy(false);
      save(null);
    }
  };
  document.addEventListener('DOMContentLoaded', () => {
    if (new URLSearchParams(location.search).get('embed') === '1') return;
    try { active = JSON.parse(sessionStorage.getItem(storageKey)); } catch { active = null; }
    if (active?.jobId) { setBusy(true); show('Checking Unity preview generation…', null); monitor(); }
  });
})();
