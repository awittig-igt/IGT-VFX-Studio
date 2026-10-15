// ── Gallery ───────────────────────────────────────────────────────────────
let allEffects = [];
let activeType = 'all';
let activeGame = 'all';
let activeSource = 'all';
let searchQuery = '';
let selectedEffectId = null;
let galleryAssetSource = 'github';
let assistantElements = null;
let galleryPreviewObserver = null;

function unloadCardPreview(card) {
  const media = card.querySelector('.card-thumb img, .card-thumb canvas');
  if (!media) return;
  media.onerror = null;
  if (media.tagName === 'IMG') media.removeAttribute('src');
  else { media.width = 0; media.height = 0; }
  media.remove();
}

function loadCardPreview(card, effect, source) {
  const thumb = card.querySelector('.card-thumb');
  if (!thumb || thumb.querySelector('img, canvas')) return;
  const drawFallback = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    canvas.className = 'thumb-canvas';
    thumb.prepend(canvas);
    drawProceduralThumb(canvas, effect);
  };
  if (!effect.files?.thumbnail) { drawFallback(); return; }
  const img = document.createElement('img');
  img.alt = effect.name || 'Effect preview';
  img.decoding = 'async';
  img.onerror = () => {
    if (img.parentNode !== thumb) return;
    img.remove();
    drawFallback();
  };
  thumb.prepend(img);
  img.src = getThumbnailURL(effect.files.thumbnail, source);
}

function clearGalleryPreviews(gallery) {
  galleryPreviewObserver?.disconnect();
  galleryPreviewObserver = null;
  gallery.querySelectorAll('.effect-card').forEach(unloadCardPreview);
}

function observeGalleryPreviews(gallery, effects) {
  const source = galleryAssetSource;
  const cards = gallery.querySelectorAll('.effect-card');
  if (typeof IntersectionObserver === 'undefined') {
    cards.forEach((card, index) => loadCardPreview(card, effects[index], source));
    return;
  }
  const effectByCard = new Map(Array.from(cards, (card, index) => [card, effects[index]]));
  const observer = new IntersectionObserver(entries => {
    // Ignore notifications queued before filtering or refreshing the gallery.
    if (galleryPreviewObserver !== observer) return;
    for (const entry of entries) {
      if (entry.isIntersecting) loadCardPreview(entry.target, effectByCard.get(entry.target), source);
      else unloadCardPreview(entry.target);
    }
  }, { rootMargin: '200px' });
  galleryPreviewObserver = observer;
  cards.forEach(card => observer.observe(card));
}

// ── Boot ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initSettings();
  initFilters();
  initAssistant();
  loadGallery();
});

// ── Settings modal ────────────────────────────────────────────────────────
function initSettings() {
  const modal   = document.getElementById('modal-settings');

  const open = async () => {
    const cfg = getConfig();
    document.getElementById('setting-repo').value     = cfg.repo     || '';
    document.getElementById('setting-branch').value   = cfg.branch   || 'main';
    document.getElementById('setting-token').value    = cfg.token    || '';
    document.getElementById('setting-localkey').value = cfg.localKey || 'effects-local-manifest';
    const serverStatus = document.getElementById('setting-server-status');
    serverStatus.textContent = '';
    serverStatus.className = 'settings-save-status hidden';

    // Load server-managed paths
    try {
      const r = await fetch('/api/config');
      if (r.ok) {
        const d = await r.json();
        document.getElementById('setting-localfolder').value = d.localFolder       || '';
        document.getElementById('setting-preview-unitypath').value =
          d.previewProjectPath || d.unityProjectPath || '';
      }
    } catch { /* server not running */ }

    modal.classList.remove('hidden');
  };

  const close   = () => modal.classList.add('hidden');
  const saveBtn = document.getElementById('btn-save-settings');

  document.getElementById('btn-settings').addEventListener('click', open);
  document.getElementById('btn-empty-settings')?.addEventListener('click', open);
  document.getElementById('btn-close-settings').addEventListener('click', close);
  document.getElementById('btn-cancel-settings').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  saveBtn.addEventListener('click', async () => {
    // Update server config. The source game project is selected in Add Project.
    const newFolder    = document.getElementById('setting-localfolder').value.trim();
    const newPreviewPath = document.getElementById('setting-preview-unitypath').value.trim();
    const serverStatus = document.getElementById('setting-server-status');
    serverStatus.textContent = 'Validating and saving server paths...';
    serverStatus.className = 'settings-save-status';
    saveBtn.disabled = true;
    if (newFolder || newPreviewPath !== undefined) {
      try {
        const response = await fetch('/api/config', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            localFolder: newFolder,
            previewProjectPath: newPreviewPath
          })
        });
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        const result = contentType.includes('application/json') ? await response.json() : {};
        if (!response.ok || !result.ok) {
          throw new Error(result.error || 'The server rejected the project path.');
        }
      } catch (error) {
        serverStatus.textContent = error.message || 'Could not save the server paths.';
        serverStatus.className = 'settings-save-status error';
        saveBtn.disabled = false;
        return;
      }
    }

    saveConfig({
      repo:     document.getElementById('setting-repo').value.trim(),
      branch:   document.getElementById('setting-branch').value.trim() || 'main',
      token:    document.getElementById('setting-token').value.trim(),
      localKey: document.getElementById('setting-localkey').value.trim() || 'effects-local-manifest'
    });
    serverStatus.textContent = 'Preview project and library paths saved.';
    serverStatus.className = 'settings-save-status success';
    saveBtn.disabled = false;
    setTimeout(() => {
      close();
      loadGallery();
    }, 450);
  });
}

// ── Filters ───────────────────────────────────────────────────────────────
function initFilters() {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeType = btn.dataset.type;
      renderGallery();
    });
  });

  document.getElementById('search').addEventListener('input', e => {
    searchQuery = e.target.value.trim().toLowerCase();
    renderGallery();
  });

  document.getElementById('game-filter').addEventListener('change', e => {
    activeGame = e.target.value;
    updateDeleteGameButton();
    renderGallery();
  });

  document.getElementById('source-filter').addEventListener('change', e => {
    activeSource = e.target.value;
    updateDeleteGameButton();
    renderGallery();
  });

  document.getElementById('btn-delete-game')?.addEventListener('click', runDeleteGame);
  document.getElementById('btn-delete-all-local')?.addEventListener('click', runDeleteAllLocal);
}

// ── Assistant chat ───────────────────────────────────────────────────────
function initAssistant() {
  const form = document.getElementById('assistant-form');
  const input = document.getElementById('assistant-input');
  const chat = document.getElementById('assistant-chat');
  const status = document.getElementById('assistant-status');
  const reset = document.getElementById('assistant-reset');
  if (!form || !input || !chat || !status || !reset) return;

  assistantElements = { form, input, chat, status, reset, initialChatMarkup: chat.innerHTML };

  form.addEventListener('submit', event => {
    event.preventDefault();
    const prompt = input.value.trim();
    if (!prompt) return;
    handleAssistantPrompt(prompt);
    input.value = '';
  });

  chat.addEventListener('click', event => {
    const button = event.target.closest('.assistant-chip');
    if (!button) return;
    const prompt = button.dataset.prompt || button.textContent || '';
    handleAssistantPrompt(prompt.trim());
  });

  reset.addEventListener('click', resetAssistantConversation);
}

function resetAssistantConversation() {
  if (!assistantElements) return;
  assistantElements.chat.innerHTML = assistantElements.initialChatMarkup;
  assistantElements.chat.scrollTop = 0;
  assistantElements.input.value = '';
  updateAssistantStatus('Ready');
  assistantElements.input.focus();
}

function handleAssistantPrompt(prompt) {
  if (!assistantElements || !prompt) return;
  appendAssistantMessage(prompt, 'user');

  const intent = parseAssistantPrompt(prompt);
  applyAssistantIntent(intent);
  renderGallery();

  const matches = filterEffects();
  const names = matches.slice(0, 3).map(effect => effect.name).filter(Boolean);
  const summary = matches.length === 0
    ? 'No effects matched yet. Try adding a game, changing type, or using different keywords.'
    : `Found ${matches.length} matching effect${matches.length === 1 ? '' : 's'}.`;
  const examples = names.length
    ? ` Top picks: ${names.join(', ')}.`
    : '';
  appendAssistantMessage(summary + examples, 'bot');
  updateAssistantStatus(matches.length === 0 ? 'No matches' : `${matches.length} matches`);
}

function parseAssistantPrompt(prompt) {
  const text = String(prompt || '').toLowerCase();
  const reset = /\b(reset|clear|all effects|show all|everything)\b/.test(text);
  const type = detectTypeFromPrompt(text);
  const source = detectSourceFromPrompt(text);

  const normalized = text
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const stopWords = new Set([
    'a','an','and','all','any','build','create','effect','effects','find','for','from',
    'i','in','is','it','like','me','need','of','or','project','projects','scan','scans',
    'show','that','the','to','uploaded','manual','with','want'
  ]);
  const keywords = normalized
    .filter(word => word.length > 2 && !stopWords.has(word))
    .map(word => word.endsWith('s') && word.length > 4 ? word.slice(0, -1) : word)
    .slice(0, 5)
    .join(' ');

  return {
    reset,
    type,
    source,
    keywords
  };
}

function detectTypeFromPrompt(text) {
  if (/\bparticles?\b/.test(text)) return 'particle';
  if (/\bshaders?\b/.test(text)) return 'shader';
  if (/\bmaterials?\b/.test(text)) return 'material';
  if (/\bvfx\b|\bvisual effects?\b/.test(text)) return 'vfx';
  return null;
}

function detectSourceFromPrompt(text) {
  if (/\bproject scan\b|\bproject scans\b|\bscanned\b/.test(text)) return 'project-scan';
  if (/\bmanual\b|\bupload\b|\buploaded\b|\.unitypackage\b/.test(text)) return 'manual-upload';
  return null;
}

function applyAssistantIntent(intent) {
  if (intent.reset) {
    activeType = 'all';
    activeGame = 'all';
    activeSource = 'all';
    searchQuery = '';
  } else {
    if (intent.type) activeType = intent.type;
    if (intent.source) activeSource = intent.source;
    searchQuery = intent.keywords || '';
  }

  const search = document.getElementById('search');
  const game = document.getElementById('game-filter');
  const source = document.getElementById('source-filter');
  if (search) search.value = searchQuery;
  if (game) game.value = activeGame;
  if (source) source.value = activeSource;

  document.querySelectorAll('.filter-btn').forEach(button => {
    button.classList.toggle('active', button.dataset.type === activeType);
  });

  updateAssistantStatus('Filtering...');
}

function appendAssistantMessage(text, role) {
  if (!assistantElements) return;
  const msg = document.createElement('div');
  msg.className = 'assistant-msg assistant-msg-' + (role === 'user' ? 'user' : 'bot');
  msg.textContent = text;
  assistantElements.chat.appendChild(msg);

  const messages = assistantElements.chat.querySelectorAll('.assistant-msg');
  if (messages.length > 14) {
    messages[0].remove();
  }
  assistantElements.chat.scrollTop = assistantElements.chat.scrollHeight;
}

function updateDeleteGameButton() {
  const deleteAll = document.getElementById('btn-delete-all-local');
  setVisible(deleteAll, galleryAssetSource === 'local' && allEffects.length > 0);
  const btn = document.getElementById('btn-delete-game');
  if (!btn) return;
  const show = galleryAssetSource === 'local' && activeGame !== 'all';
  setVisible(btn, show);
}

async function runDeleteAllLocal() {
  if (galleryAssetSource !== 'local') return;
  if (!window.confirm('Are you sure you want to delete ALL local packages?\n\nThis permanently removes every effect from the local FindFX library, including its package files, source copies, and previews, across all games and filters. Your original Unity projects and remote libraries are not changed. This cannot be undone.')) return;
  const button = document.getElementById('btn-delete-all-local');
  const status = document.getElementById('delete-local-status');
  button.disabled = true;
  button.textContent = 'Deleting local packages…';
  status.classList.remove('error');
  status.textContent = 'Deleting local package files, previews, and gallery entries. Please wait…';
  try {
    const response = await fetch('/api/delete-all-local', { method: 'POST' });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `Delete failed (${response.status}).`);
    allEffects.forEach(deleteFromLocalCache);
    allEffects = [];
    selectedEffectId = null;
    activeGame = 'all';
    const games = document.getElementById('game-filter');
    games.innerHTML = '<option value="all">All Games</option>';
    renderGallery();
    document.getElementById('side-preview-media').replaceChildren();
    document.getElementById('empty-msg').textContent = 'Your local library is empty.';
    document.getElementById('empty-sub').textContent = 'Scan a Unity project or import a package to add effects again.';
    updateDeleteGameButton();
    status.textContent = `Deleted ${result.deleted} local effects and ${result.removedFiles} files. The local library is empty.`;
  } catch (error) {
    status.classList.add('error');
    status.textContent = `Deletion could not finish: ${error.message} Refresh the library before retrying.`;
  } finally {
    button.disabled = false;
    button.textContent = 'Delete all local packages';
  }
}

async function runDeleteGame() {
  if (galleryAssetSource !== 'local' || activeGame === 'all') return;
  const gameName = activeGame;
  const count = allEffects.filter(e => (e.game || '') === gameName).length;
  if (count === 0) return;

  const ok = window.confirm(
    `Delete all ${count} effect${count === 1 ? '' : 's'} from "${gameName}"?\n\nThis removes them from the local library permanently.`
  );
  if (!ok) return;

  const btn = document.getElementById('btn-delete-game');
  const savedHTML = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Deleting\u2026';

  let serverFailed = false;
  const toDelete = allEffects.filter(e => (e.game || '') === gameName);

  try {
    if (location.protocol !== 'file:') {
      try {
        const response = await fetch('/api/delete-game', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game: gameName })
        });
        const ct = (response.headers.get('content-type') || '').toLowerCase();
        const result = ct.includes('application/json') ? await response.json() : {};
        if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      } catch (err) {
        console.warn('[effects-extractor] delete-game server call failed:', err.message);
        serverFailed = true;
      }
    }

    // Always clean up localStorage copies too.
    for (const effect of toDelete) deleteFromLocalCache(effect);

    allEffects = allEffects.filter(e => (e.game || '') !== gameName);
    selectedEffectId = null;
    activeGame = 'all';

    // Rebuild game filter dropdown.
    const sel = document.getElementById('game-filter');
    const remaining = [...new Set(allEffects.map(e => e.game).filter(Boolean))].sort();
    sel.innerHTML = '<option value="all">All Games</option>';
    remaining.forEach(g => {
      const o = document.createElement('option');
      o.value = g; o.textContent = g;
      sel.appendChild(o);
    });
    sel.value = 'all';

    renderGallery();

    if (serverFailed) {
      window.alert(
        `"${gameName}" was removed from this session but the server persist failed.\n` +
        `Effects will reappear on next reload. Make sure you are using http://localhost:8081/`
      );
    }
  } finally {
    // Restore button so subsequent game deletes work.
    btn.disabled = false;
    btn.innerHTML = savedHTML;
    updateDeleteGameButton();
  }
}

function updateAssistantStatus(value) {
  if (!assistantElements) return;
  assistantElements.status.textContent = value;
}

// ── Load manifest (GitHub first, sessionStorage fallback) ────────────────
async function loadGallery() {
  const loading = document.getElementById('loading-state');
  const empty   = document.getElementById('empty-state');
  const gallery = document.getElementById('gallery');
  const banner  = document.getElementById('local-preview-banner');

  setVisible(loading, true);
  setVisible(empty,   false);
  if (banner) banner.classList.add('hidden');
  clearGalleryPreviews(gallery);
  gallery.innerHTML = '';

  const cfg = getConfig();
  const findFX = new URLSearchParams(window.location.search).get('findfx') === '1';
  let manifest = null;
  let isLocal  = false;

  // 1. Try GitHub
  if (cfg.repo && !findFX) {
    try { manifest = await fetchManifest(); } catch {}
  }

  // 2. Try local server folder (/local/manifest.json served by serve.ps1)
  if (!manifest || !(manifest.effects || []).length) {
    try {
      const r = await fetch('/local/manifest.json', { cache: 'no-store' });
      if (r.ok) {
        const m = await r.json();
        if ((m.effects || []).length) { manifest = m; isLocal = true; }
      }
    } catch {}
  }

  // 3. Fall back to localStorage cache
  if (!findFX && (!manifest || !(manifest.effects || []).length)) {
    const local = getLocalManifest();
    if (local && (local.effects || []).length) { manifest = local; isLocal = true; }
  }

  // 3. Nothing found
  if (!manifest || !(manifest.effects || []).length) {
    setVisible(loading, false);
    setVisible(empty, true);
    document.getElementById('empty-msg').textContent = 'No effects found yet.';
    document.getElementById('empty-sub').textContent = findFX
      ? 'FindFX previews will appear here when Unity finishes. Follow progress and logs below.'
      : 'Use \u201cAdd Project\u201d to scan a Unity project, then Download ZIP and push the contents to your repo.';
    return;
  }

  allEffects = manifest.effects || [];
  galleryAssetSource = isLocal ? 'local' : 'github';
  if (isLocal && banner && !isLocalPreviewDismissed()) banner.classList.remove('hidden');
  updateAssistantStatus('Ready');

  // Build game filter
  const games = [...new Set(allEffects.map(e => e.game).filter(Boolean))].sort();
  const sel = document.getElementById('game-filter');
  sel.innerHTML = '<option value="all">All Games</option>';
  games.forEach(g => { const o = document.createElement('option'); o.value = g; o.textContent = g; sel.appendChild(o); });

  updateDeleteGameButton();
  setVisible(loading, false);
  renderGallery();
}

// ── Render filtered gallery ───────────────────────────────────────────────
function renderGallery() {
  const gallery = document.getElementById('gallery');
  const empty   = document.getElementById('empty-state');
  const filtered = filterEffects();

  clearGalleryPreviews(gallery);

  document.getElementById('effect-count').textContent =
    `${filtered.length} effect${filtered.length !== 1 ? 's' : ''}`;

  if (filtered.length === 0) {
    gallery.innerHTML = '';
    setVisible(document.getElementById('side-preview'), false);
    document.getElementById('empty-msg').textContent = 'No effects match your filters.';
    document.getElementById('empty-sub').textContent  = '';
    setVisible(empty, true);
    return;
  }

  setVisible(empty, false);
  gallery.innerHTML = filtered.map(effectCard).join('');

  gallery.querySelectorAll('.effect-card').forEach((card, index) => {
    const effect = filtered[index];
    card.onclick = () => showSidePreview(effect);
    card.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        showSidePreview(effect);
      }
    };
    const downloadButton = card.querySelector('.card-download');
    if (downloadButton) {
      downloadButton.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        await runDownload(downloadButton, getEffectDownloadItems(effect, galleryAssetSource)[0]);
      });
    }
    const deleteButton = card.querySelector('.card-delete');
    if (deleteButton) {
      deleteButton.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        await runDelete(effect);
      });
    }
    const thumb = card.querySelector('.card-thumb');
    if (thumb) {
      thumb.addEventListener('contextmenu', async event => {
        event.preventDefault();
        event.stopPropagation();
        await runDelete(effect);
      });
      thumb.title = galleryAssetSource === 'local'
        ? 'Right-click to delete this effect from local library'
        : 'Right-click delete is available for local effects only';
    }
    card.classList.toggle('selected', effect.id === selectedEffectId);
  });

  observeGalleryPreviews(gallery, filtered);

  const selected = filtered.find(effect => effect.id === selectedEffectId) || filtered[0];
  if (selected) showSidePreview(selected);
}

// ── Filter logic ──────────────────────────────────────────────────────────
function filterEffects() {
  return allEffects.filter(e => {
    if (activeType !== 'all' && e.type !== activeType) return false;
    if (activeGame !== 'all' && e.game !== activeGame) return false;
    if (activeSource !== 'all' && getEffectImportSource(e) !== activeSource) return false;
    if (searchQuery) {
      const hay = [e.name, e.game, e.type, getEffectImportSource(e), ...(e.tags || [])].join(' ').toLowerCase();
      const terms = searchQuery.split(/\s+/).map(token => token.trim()).filter(Boolean);
      if (terms.some(term => !hay.includes(term))) return false;
    }
    return true;
  });
}

// ── Card HTML ─────────────────────────────────────────────────────────────
function effectCard(e) {
  const tags  = (e.tags || []).slice(0, 3).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const primaryDownload = getEffectDownloadItems(e, galleryAssetSource)[0];
  const canDelete = galleryAssetSource === 'local';

  return `
    <div class="effect-card" data-effect-id="${escAttr(esc(e.id))}" tabindex="0" role="button"
         onclick="openViewer('${esc(e.id)}')"
         onkeydown="if(event.key==='Enter')openViewer('${esc(e.id)}')">
      <div class="card-thumb">

        ${primaryDownload ? `<button type="button" class="card-download" title="${primaryDownload.kind === 'package' ? 'Download Unity package' : 'Download file'}" aria-label="Download ${escAttr(e.name)}">↓</button>` : ''}
        ${canDelete ? `<button type="button" class="card-delete" title="Delete effect" aria-label="Delete ${escAttr(e.name)}">×</button>` : ''}
        <span class="card-type-badge type-${e.type}">${esc(e.type)}</span>
      </div>
      <div class="card-body">
        <h3 class="card-title" title="${escAttr(e.name)}">${esc(e.name)}</h3>
        <p class="card-game">${esc(e.game || '')}</p>
        <div class="card-tags">${tags}</div>
      </div>
    </div>`;
}

// ── Navigate to viewer ────────────────────────────────────────────────────
function showSidePreview(effect) {
  selectedEffectId = effect.id;
  const panel = document.getElementById('side-preview');
  const media = document.getElementById('side-preview-media');
  const type = document.getElementById('side-preview-type');
  const tags = document.getElementById('side-preview-tags');
  const downloadButton = document.getElementById('side-preview-download');
  const sendUnityButton = document.getElementById('side-preview-send-unity');

  setVisible(panel, true);
  document.getElementById('side-preview-name').textContent = effect.name || 'Untitled effect';
  document.getElementById('side-preview-game').textContent = effect.game || 'Unknown project';
  type.textContent = effect.type || 'effect';
  type.className = 'card-type-badge type-' + (effect.type || '');

  tags.replaceChildren();
  (effect.tags || []).slice(0, 5).forEach(value => {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = value;
    tags.appendChild(tag);
  });

  const frame = document.createElement('iframe');
  frame.className = 'side-preview-frame';
  frame.title = (effect.name || 'Effect') + ' preview';
  frame.src = 'viewer.html?id=' + encodeURIComponent(effect.id) + '&embed=1';
  media.replaceChildren(frame);

  const downloads = getEffectDownloadItems(effect, galleryAssetSource);
  const sourceDownload = downloads.find(item => item.kind === 'package') || downloads.find(item => item.kind === 'source');
  const packageDownload = downloads.find(item => item.kind === 'package');
  setVisible(downloadButton, Boolean(sourceDownload));
  setVisible(sendUnityButton, Boolean(packageDownload));
  downloadButton.textContent = sourceDownload?.kind === 'package' ? 'Download Unity Package' : 'Download file';
  downloadButton.onclick = () => runDownload(downloadButton, sourceDownload);
  sendUnityButton.onclick = () => regenerateUnityPreview(effect, galleryAssetSource);
  sendUnityButton.dataset.effectId = effect.id;
  window.refreshPreviewRegenerationButtons();
  document.dispatchEvent(new CustomEvent('effect-ready', { detail: { effect, source: galleryAssetSource } }));

  document.getElementById('side-preview-open').onclick = () => openViewer(effect.id);
  document.querySelectorAll('.effect-card').forEach(card => card.classList.remove('selected'));
  const selectedCard = Array.from(document.querySelectorAll('.effect-card')).find(card => {

    return card.dataset.effectId === String(effect.id);
  });
  selectedCard?.classList.add('selected');
}

function openViewer(id) {
  window.location.href = `viewer.html?id=${encodeURIComponent(id)}`;
}

async function runDownload(button, item) {
  if (!item) return;
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = 'Downloading…';
  try {
    await downloadEffectItem(item);
  } catch (error) {
    button.textContent = 'Download failed';
    console.error('[effects-extractor] download failed:', error);
    await new Promise(resolve => setTimeout(resolve, 1400));
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

async function runDelete(effect) {
  if (!effect || galleryAssetSource !== 'local') return;
  const ok = window.confirm(`Delete "${effect.name || 'this effect'}" from the local library?\n\nThis will remove it from the gallery and its local files.`);
  if (!ok) return;

  // Optimistically remove from UI immediately so feedback is instant.
  allEffects = allEffects.filter(item => !isSameEffect(item, effect));
  selectedEffectId = null;
  renderGallery();

  // Persist deletion: try server first, fall back to localStorage cache.
  if (location.protocol !== 'file:') {
    try {
      const response = await fetch('/api/delete-effect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: effect.id || null,
          originalPath: effect.originalPath || null,
          name: effect.name || null,
          type: effect.type || null,
          game: effect.game || null
        })
      });
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const result = contentType.includes('application/json') ? await response.json() : {};
      if (!response.ok || !result.ok) {
        throw new Error(result.error || `Server responded ${response.status}`);
      }
      // Server persist succeeded; also clean up any localStorage copy.
      deleteFromLocalCache(effect);
      return;
    } catch (err) {
      console.warn('[effects-extractor] server delete failed, trying cache:', err.message);
    }
  }

  // localStorage fallback (file:// mode or server unavailable).
  if (!deleteFromLocalCache(effect)) {
    // Neither persist path worked — warn the user the deletion won't survive a reload.
    window.alert(
      `"${effect.name || 'Effect'}" was removed from the gallery for this session.\n\n` +
      `It could not be saved permanently because the local server is unavailable.\n` +
      `Reload the page to restore it, or restart serve.ps1 and try again.`
    );
  }
}

function deleteFromLocalCache(effect) {
  const local = getLocalManifest();
  if (!local || !Array.isArray(local.effects)) return false;
  const nextEffects = local.effects.filter(item => !isSameEffect(item, effect));
  if (nextEffects.length === local.effects.length) return false;
  local.effects = nextEffects;
  local.generatedAt = new Date().toISOString();
  saveLocalManifest(local);
  return true;
}

function isSameEffect(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id === b.id;
  if (a.originalPath && b.originalPath) return a.originalPath === b.originalPath;
  return (a.name || '') === (b.name || '') &&
    (a.type || '') === (b.type || '') &&
    (a.game || '') === (b.game || '');
}

// ── Procedural canvas thumbnail ───────────────────────────────────────────
function drawProceduralThumb(canvas, effect) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // Per-type dark background gradient
  const bgColors = {
    particle: ['#1a0800', '#3a1200', '#7a2800'],
    shader:   ['#08001a', '#15003a', '#2a0080'],
    vfx:      ['#001618', '#002d30', '#005a60'],
    material: ['#030d16', '#071e30', '#0d3a5c']
  }[effect.type] || ['#0d0d0d', '#1a1a1a', '#2a2a2a'];

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, bgColors[0]);
  bg.addColorStop(0.55, bgColors[1]);
  bg.addColorStop(1, bgColors[2]);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // For particles, draw a glowing radial burst using startColor
  if (effect.type === 'particle') {
    const c   = effect.metadata?.startColor || { r: 1, g: 0.5, b: 0 };
    const r   = Math.round(Math.min(c.r, 1) * 255);
    const g   = Math.round(Math.min(c.g, 1) * 255);
    const b   = Math.round(Math.min(c.b, 1) * 255);

    // Central glow
    const glow = ctx.createRadialGradient(W*0.5, H*0.55, 0, W*0.5, H*0.55, H*0.55);
    glow.addColorStop(0,   `rgba(${r},${g},${b},0.9)`);
    glow.addColorStop(0.4, `rgba(${r},${g},${b},0.35)`);
    glow.addColorStop(1,   `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // Scatter a few particle dots
    ctx.fillStyle = `rgba(${Math.min(r+60,255)},${Math.min(g+60,255)},${Math.min(b+60,255)},0.7)`;
    const seed = effect.name.length * 7;
    for (let i = 0; i < 18; i++) {
      const angle = (seed + i * 37) % 360 * Math.PI / 180;
      const dist  = 15 + ((seed + i * 23) % 50);
      const px    = W*0.5 + Math.cos(angle) * dist;
      const py    = H*0.55 + Math.sin(angle) * dist * 0.7;
      const size  = 1.5 + ((seed + i * 13) % 4);
      ctx.beginPath();
      ctx.arc(px, py, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // For shaders, draw animated-looking horizontal scan lines
  if (effect.type === 'shader') {
    const lineColor = effect.metadata?.hasHLSL ? '#7c3aed' : '#a78bfa';
    ctx.strokeStyle = lineColor;
    ctx.lineWidth   = 0.5;
    ctx.globalAlpha = 0.25;
    for (let y = 4; y < H; y += 8) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const sphereGrad = ctx.createRadialGradient(W*0.5, H*0.48, 0, W*0.5, H*0.48, H*0.42);
    sphereGrad.addColorStop(0, 'rgba(124,58,237,0.6)');
    sphereGrad.addColorStop(0.5, 'rgba(124,58,237,0.2)');
    sphereGrad.addColorStop(1, 'rgba(124,58,237,0)');
    ctx.fillStyle = sphereGrad;
    ctx.fillRect(0, 0, W, H);
  }

  // Type icon (centered, large, semi-transparent)
  const icons = { particle: '✦', shader: '◈', vfx: '⬡', material: '◉' };
  ctx.globalAlpha = 0.18;
  ctx.fillStyle   = '#ffffff';
  ctx.font        = `bold ${H * 0.55}px system-ui`;
  ctx.textAlign   = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(icons[effect.type] || '✦', W / 2, H / 2);
  ctx.globalAlpha = 1;

  // Name label at the bottom
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, H - 22, W, 22);
  ctx.fillStyle   = 'rgba(255,255,255,0.8)';
  ctx.font        = '11px system-ui';
  ctx.textAlign   = 'center';
  ctx.textBaseline = 'middle';
  const label = effect.name.length > 24 ? effect.name.slice(0, 23) + '…' : effect.name;
  ctx.fillText(label, W / 2, H - 11);
}

// ── Utility ───────────────────────────────────────────────────────────────
function typeIcon(t) {
  return { particle: '✦', shader: '◈', vfx: '⬡', material: '◉' }[t] || '✦';
}
function esc(s)     { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return String(s ?? '').replace(/"/g,'&quot;'); }
function setVisible(el, v) { el?.classList.toggle('hidden', !v); }

document.addEventListener('preview-regenerated', ({ detail: { effect } }) => {
  if (galleryAssetSource !== 'local') return;
  allEffects = allEffects.map(item => item.id === effect.id ? effect : item);
  renderGallery();
});
