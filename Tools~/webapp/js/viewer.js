// ── Viewer ────────────────────────────────────────────────────────────────
let currentEffect = null;
let livePreview   = null;
let currentAssetSource = 'github';

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  const embedded = params.get('embed') === '1';
  if (embedded) document.body.classList.add('embedded');
  if (!id) { showError('No effect ID in URL.'); return; }

  // Try GitHub manifest first, then fall back to sessionStorage local preview
  let manifest = null;
  const cfg = getConfig();
  if (cfg.repo) {
    try { manifest = await fetchManifest(); } catch {}
  }
  if (!manifest || !(manifest.effects || []).length) {
    try {
      const response = await fetch('/local/manifest.json');
      if (response.ok) {
        manifest = await response.json();
        if ((manifest.effects || []).length) currentAssetSource = 'local';
      }
    } catch {}
  }
  if (!manifest || !(manifest.effects || []).length) {
    manifest = getLocalManifest();
    if (manifest) currentAssetSource = 'local';
  }
  if (!manifest) {
    showError('No manifest found. Go back to the gallery and scan a project first.');
    return;
  }

  currentEffect = (manifest.effects || []).find(e => e.id === id);
  if (!currentEffect) { showError(`Effect "${id}" not found. Try reloading the gallery.`); return; }
  render(currentEffect);
  if (embedded) document.getElementById('btn-live-tab').click();
}

// ── Render effect ─────────────────────────────────────────────────────────
function render(e) {
  document.title = `${e.name} — Effects Extractor Library`;
  document.getElementById('effect-title').textContent = e.name;

  const badgeType = document.getElementById('badge-type');
  badgeType.textContent = e.type;
  badgeType.className   = `badge type-${e.type}`;

  document.getElementById('badge-game').textContent = e.game || '—';

  // Thumbnail
  const thumbUrl = e.files?.thumbnail ? getThumbnailURL(e.files.thumbnail, currentAssetSource) : null;
  const thumbEl  = document.getElementById('preview-thumbnail');
  if (thumbUrl) {
    thumbEl.src = thumbUrl;
    thumbEl.removeAttribute('data-load-error');
    thumbEl.onerror = () => {
      thumbEl.dataset.loadError = '1';
      thumbEl.classList.add('hidden');
      showPlaceholder(
        e.type === 'particle' || e.type === 'shader'
          ? 'No thumbnail available'
          : 'Unity Editor capture could not be loaded'
      );
    };
  } else {
    thumbEl.classList.add('hidden');
    showPlaceholder('No thumbnail available');
  }

  fillMetadata(e);
  loadSource(e);
  fillFiles(e);
  initTabs();
  initPreviewTabs(e);
}

// ── Metadata table ────────────────────────────────────────────────────────
function fillMetadata(e) {
  const rows = [
    ['Name',          e.name],
    ['Type',          e.type],
    ['Source',        getEffectImportSource(e) === 'manual-upload' ? 'Uploaded manually' : 'Project scan'],
    ['Game',          e.game],
    ['Original Path', e.originalPath],
    ['Extracted',     e.extractedAt ? new Date(e.extractedAt).toLocaleDateString() : '—']
  ];

  const m = e.metadata || {};
  if (e.type === 'particle') {
    if (m.duration     != null) rows.push(['Duration',       `${m.duration}s`]);
    if (m.looping      != null) rows.push(['Looping',        m.looping ? 'Yes' : 'No']);
    if (m.maxParticles != null) rows.push(['Max Particles',  m.maxParticles]);
    if (m.emission?.rateOverTime != null) rows.push(['Emission Rate', `${m.emission.rateOverTime}/s`]);
    if (m.shape?.type)           rows.push(['Emission Shape', m.shape.type]);
    if (m.startSpeed?.value != null)    rows.push(['Start Speed',   m.startSpeed.value]);
    if (m.startLifetime?.value != null) rows.push(['Lifetime',      `${m.startLifetime.value}s`]);
  } else if (e.type === 'shader') {
    if (m.isShaderGraph) rows.push(['Format', 'Shader Graph']);
    else if (m.hasHLSL)  rows.push(['Format', 'HLSL']);
    else if (m.hasCGPROGRAM) rows.push(['Format', 'CG/HLSL']);
    if (m.renderQueue) rows.push(['Render Queue', m.renderQueue]);
    if (m.fallback)    rows.push(['Fallback',     m.fallback]);
    if (m.properties?.length) rows.push(['Properties', m.properties.map(p => p.displayName).join(', ')]);
  }

  if (e.tags?.length) rows.push(['Tags', e.tags.join(', ')]);

  document.getElementById('meta-tbody').innerHTML = rows
    .map(([k, v]) => `<tr><td class="meta-key">${k}</td><td class="meta-val">${esc(v ?? '—')}</td></tr>`)
    .join('');
}

// ── Source code ───────────────────────────────────────────────────────────
async function loadSource(e) {
  const ext = (e.files?.main || '').split('.').pop().toLowerCase();
  const showableExts = new Set(['shader','shadergraph','hlsl','cginc','vfx','glsl']);
  if (!showableExts.has(ext)) return;

  document.getElementById('source-filename').textContent = (e.files.main || '').split('/').pop();

  try {
    const content = await fetchEffectFileContent(e.files.main, currentAssetSource);
    const codeEl  = document.getElementById('source-code');
    codeEl.textContent = content;
    codeEl.className   = ext === 'shadergraph' ? 'language-json' : 'language-glsl';
    if (typeof Prism !== 'undefined') Prism.highlightElement(codeEl);
  } catch (err) {
    document.getElementById('source-code').textContent = `// Could not load source:\n// ${err.message}`;
  }

  document.getElementById('btn-copy-source').addEventListener('click', () => {
    const text = document.getElementById('source-code').textContent;
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('btn-copy-source');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    });
  });
}

// ── Files panel ───────────────────────────────────────────────────────────
function fillFiles(e) {
  const items = getEffectDownloadItems(e, currentAssetSource);

  const list = document.getElementById('files-list');
  list.innerHTML = items.map((item, index) => {
    const canSend = item.kind === 'package';
    return `
      <li class="file-item">
        <span class="file-label">${esc(item.label)}</span>
        <span class="file-path" title="${escAttr(item.filename)}">${esc(item.filename)}</span>
        <div class="file-actions">
          ${canSend ? `<button class="btn-secondary btn-sm" type="button" data-send-index="${index}">Send to Unity</button>` : ''}
          <button class="btn-secondary btn-sm" type="button" data-download-index="${index}">Download</button>
        </div>
      </li>`;
  }).join('');

  list.querySelectorAll('[data-download-index]').forEach(button => {
    button.addEventListener('click', async () => {
      const item = items[Number(button.dataset.downloadIndex)];
      const oldText = button.textContent;
      button.disabled = true;
      button.textContent = 'Downloading…';
      try {
        await downloadEffectItem(item);
      } catch (error) {
        button.textContent = 'Failed';
        await new Promise(resolve => setTimeout(resolve, 1200));
      } finally {
        button.disabled = false;
        button.textContent = oldText;
      }
    });
  });

  list.querySelectorAll('[data-send-index]').forEach(button => {
    button.addEventListener('click', async () => {
      const item = items[Number(button.dataset.sendIndex)];
      const oldText = button.textContent;
      button.disabled = true;
      button.textContent = 'Fetching…';
      try {
        const response = await _get(item.url, getConfig().token);
        if (!response.ok) throw new Error(`Could not fetch package: ${response.status}`);
        const blob = await response.blob();
        button.textContent = 'Sending…';
        const result = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/upload-package');
          xhr.setRequestHeader('X-Filename', encodeURIComponent(item.filename || 'effect.unitypackage'));
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); }
            } else {
              let msg = `Send failed (${xhr.status})`;
              try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
              reject(new Error(msg));
            }
          };
          xhr.onerror = () => reject(new Error('Network error during upload'));
          xhr.send(blob);
        });
        button.textContent = result?.warning ? 'Sent (no preview)' : 'Sent to Unity!';
        await new Promise(r => setTimeout(r, 1500));
      } catch (err) {
        button.textContent = 'Send failed';
        console.error('[effects-extractor] send to unity failed:', err);
        await new Promise(r => setTimeout(r, 1400));
      } finally {
        button.disabled = false;
        button.textContent = oldText;
      }
    });
  });
}

// ── Info tabs ─────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.info-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.info-tabs .tab-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.panel-content').forEach(p => p.classList.add('hidden'));

      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      document.getElementById(`panel-${btn.dataset.panel}`).classList.remove('hidden');
    });
  });
}

// ── Preview tabs ──────────────────────────────────────────────────────────
function initPreviewTabs(e) {
  const btnThumb = document.getElementById('btn-thumb-tab');
  const btnLive  = document.getElementById('btn-live-tab');
  const liveDot  = document.getElementById('live-tab-dot');
  const liveLabel = document.getElementById('live-tab-label');
  const thumbEl  = document.getElementById('preview-thumbnail');
  const canvas   = document.getElementById('preview-canvas');
  const loading  = document.getElementById('preview-loading');
  const resetCamera = document.getElementById('btn-reset-cam');
  const sourceBadge = document.getElementById('preview-source-badge');
  const supportsLive = e.type === 'particle' || (e.type === 'shader' && Boolean(e.files?.main));
  const hasCapture = Boolean(e.files?.thumbnail);

  if (!supportsLive) {
    liveLabel.textContent = 'Unity Capture';
    liveDot.classList.add('hidden');
    resetCamera.classList.add('hidden');
    document.querySelector('.preview-toolbar')?.classList.add('capture-fallback');
  }

  btnThumb.addEventListener('click', () => {
    activatePreviewTab(btnThumb, btnLive);
    canvas.classList.add('hidden');
    sourceBadge.classList.add('hidden');
    hidePlaceholder();
    // Only show the thumbnail if it loaded successfully (no data-load-error)
    if (hasCapture && thumbEl.src && !thumbEl.dataset.loadError) {
      thumbEl.classList.remove('hidden');
    } else {
      showPlaceholder('No thumbnail available');
    }
    stopLive();
  });

  btnLive.addEventListener('click', async () => {
    activatePreviewTab(btnLive, btnThumb);
    thumbEl.classList.add('hidden');
    sourceBadge.classList.add('hidden');
    hidePlaceholder();

    stopLive();

    // Browser renderers currently exist only for parsed particle metadata and
    // standalone shader source. Prefab VFX can depend on Unity renderers,
    // materials, scripts, Shader Graph, or VFX Graph, so use the image rendered
    // by the Unity capture scene instead of pretending to reproduce it here.
    if (!supportsLive) {
      if (hasCapture && thumbEl.src && !thumbEl.dataset.loadError) {
        thumbEl.classList.remove('hidden');
        sourceBadge.classList.remove('hidden');
      } else {
        showPlaceholder('No Unity Editor capture is available for this effect');
      }
      return;
    }

    loading.classList.remove('hidden');

    try {
      if (e.type === 'particle') {
        livePreview = new ParticlePreview(canvas, e.metadata || {});
        canvas.classList.remove('hidden');
      } else if (e.type === 'shader') {
        const src = e.files?.main ? await fetchEffectFileContent(e.files.main, currentAssetSource).catch(() => null) : null;
        livePreview = new ShaderPreview(canvas, src, e.metadata || {});
        canvas.classList.remove('hidden');
      }
    } catch (err) {
      showPlaceholder(`Preview error: ${err.message}`);
    } finally {
      loading.classList.add('hidden');
    }
  });

  resetCamera.addEventListener('click', () => {
    livePreview?.resetCamera?.();
  });
}

function activatePreviewTab(on, off) {
  on.classList.add('active');
  off.classList.remove('active');
}

function stopLive() {
  if (livePreview) { livePreview.stop(); livePreview = null; }
}

function showPlaceholder(msg) {
  const ph = document.getElementById('preview-placeholder');
  document.getElementById('preview-source-badge')?.classList.add('hidden');
  ph.querySelector('p').textContent = msg || 'Not available';
  ph.classList.remove('hidden');
}
function hidePlaceholder() {
  document.getElementById('preview-placeholder').classList.add('hidden');
}

// ── Error state ───────────────────────────────────────────────────────────
function showError(msg) {
  document.getElementById('effect-title').textContent = 'Error';
  showPlaceholder(msg);
}

// ── Utility ───────────────────────────────────────────────────────────────
function esc(s)     { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return String(s ?? '').replace(/"/g,'&quot;'); }
