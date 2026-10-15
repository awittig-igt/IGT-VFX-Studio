// ── Config helpers ────────────────────────────────────────────────────────
const CONFIG_KEY = 'effects-lib-config';

const DEFAULTS = { repo: '', branch: 'main', token: '', localKey: 'effects-local-manifest' };

function getConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? Object.assign({}, DEFAULTS, JSON.parse(raw)) : Object.assign({}, DEFAULTS);
  } catch {
    return Object.assign({}, DEFAULTS);
  }
}

function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

function getRawBaseURL(path) {
  const { repo, branch } = getConfig();
  if (!repo) return null;
  const b = branch || 'main';
  const p = path ? path.replace(/^\//, '') : '';
  return `https://raw.githubusercontent.com/${repo}/${b}/${p}`;
}

// ── Local manifest (localStorage, key configurable in Settings) ─────────────
function _localKey() {
  return getConfig().localKey || 'effects-local-manifest';
}
function saveLocalManifest(manifest) {
  try { localStorage.setItem(_localKey(), JSON.stringify(manifest)); } catch {}
}
function getLocalManifest() {
  try {
    const raw = localStorage.getItem(_localKey());
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function clearLocalManifest() {
  try { localStorage.removeItem(_localKey()); } catch {}
}

// Dismiss the notice without clearing effects or reloading the gallery.
let localPreviewDismissed = false;
function isLocalPreviewDismissed() {
  if (localPreviewDismissed) return true;
  try { return sessionStorage.getItem('findfx-preview-dismissed:' + _localKey()) === '1'; }
  catch { return false; }
}
function dismissLocalPreview() {
  localPreviewDismissed = true;
  try { sessionStorage.setItem('findfx-preview-dismissed:' + _localKey(), '1'); } catch {}
  document.getElementById('local-preview-banner')?.classList.add('hidden');
}