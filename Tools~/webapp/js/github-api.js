// ── GitHub API helpers ────────────────────────────────────────────────────

/**
 * Fetch the manifest.json from the centralized repo.
 * Uses raw.githubusercontent.com (no rate-limit concerns for small files).
 */
async function fetchManifest() {
  const cfg = getConfig();
  if (!cfg.repo) throw new Error('No repo configured. Open Settings and enter your centralized repo.');

  const url = getRawBaseURL('manifest.json');
  const res = await _get(url, cfg.token);

  if (res.status === 404) {
    throw new Error(`manifest.json not found in "${cfg.repo}". Run the extractor first, then push the output to that repo.`);
  }
  if (!res.ok) throw new Error(`Failed to load manifest: ${res.status} ${res.statusText}`);

  return res.json();
}

/**
 * Fetch any text file from the centralized repo by its repo-relative path.
 */
async function fetchFileContent(repoPath) {
  const cfg = getConfig();
  const url = getRawBaseURL(repoPath);
  const res = await _get(url, cfg.token);
  if (!res.ok) throw new Error(`Could not fetch "${repoPath}": ${res.status}`);
  return res.text();
}

/**
 * Return the raw URL for a thumbnail (or null if path is falsy).
 */
function getThumbnailURL(thumbnailPath, source = 'github') {
  return thumbnailPath ? getEffectAssetURL(thumbnailPath, source) : null;
}

/**
 * Resolve an effect asset against the manifest it came from. Local manifests
 * are served by serve.ps1 under /local/; GitHub manifests use the configured
 * repository. Keeping this explicit prevents a configured or empty GitHub
 * repo from breaking valid local Unity captures.
 */
function getEffectAssetURL(assetPath, source = 'github') {
  if (!assetPath) return null;
  if (/^https?:\/\//i.test(assetPath)) return assetPath;
  if (source === 'local') {
    const clean = String(assetPath).replace(/\\/g, '/').replace(/^\/+/, '');
    return '/local/' + clean.split('/').map(encodeURIComponent).join('/');
  }
  return getRawBaseURL(assetPath);
}

async function fetchEffectFileContent(assetPath, source = 'github') {
  if (source !== 'local') return fetchFileContent(assetPath);
  const url = getEffectAssetURL(assetPath, source);
  const res = await _get(url, null);
  if (!res.ok) throw new Error(`Could not fetch "${assetPath}": ${res.status}`);
  return res.text();
}

/** Identify how an effect entered the library, including older manifests. */
function getEffectImportSource(effect) {
  if (effect?.importSource) return effect.importSource;
  return /-unity-[0-9a-f]{8}$/i.test(effect?.id || '')
    ? 'manual-upload'
    : 'project-scan';
}

function getEffectDownloadItems(effect, source = 'github') {
  const items = [];
  if (effect?.files?.package) {
    items.push({
      kind: 'package',
      label: 'Unity package',
      filename: String(effect.files.package).split('/').pop(),
      url: getEffectAssetURL(effect.files.package, source)
    });
  }
  if (effect?.files?.main) {
    items.push({
      kind: 'source',
      label: 'Source file',
      filename: String(effect.files.main).split('/').pop(),
      url: getEffectAssetURL(effect.files.main, source)
    });
  } else if (!effect?.files?.package && source === 'local' && getEffectImportSource(effect) === 'manual-upload') {
    const packageFilename = effect.packageFile || `${effect.name || 'effect'}.unitypackage`;
    const packageQuery = effect.packageFile
      ? 'name=' + encodeURIComponent(effect.packageFile)
      : 'assetPath=' + encodeURIComponent(effect.originalPath || '');
    items.push({
      kind: 'package',
      label: 'Unity package',
      filename: packageFilename,
      url: '/api/unity-package?' + packageQuery
    });
    if (/^Assets[\\/]/i.test(effect?.originalPath || '')) items.push({
      kind: 'unity-asset',
      label: 'Unity asset (prefab only)',
      filename: String(effect.originalPath).replace(/\\/g, '/').split('/').pop(),
      url: '/api/unity-asset?path=' + encodeURIComponent(effect.originalPath)
    });
  }
  if (effect?.files?.thumbnail) {
    items.push({
      kind: 'preview',
      label: 'Preview image',
      filename: String(effect.files.thumbnail).split('/').pop(),
      url: getEffectAssetURL(effect.files.thumbnail, source)
    });
  }
  return items.filter(item => item.url);
}

async function downloadEffectItem(item) {
  if (!item?.url) throw new Error('No downloadable file is available.');
  const response = await _get(item.url, getConfig().token);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = item.filename || 'effect-file';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

// ── Internal ──────────────────────────────────────────────────────────────
function _get(url, token, timeoutMs) {
  const headers = {};
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 15000);
  if (token) {
    // Only attach the header for requests to GitHub domains
    const hostname = new URL(url).hostname;
    if (hostname.endsWith('github.com') || hostname.endsWith('githubusercontent.com')) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  }
  return fetch(url, { headers, signal: controller.signal })
    .finally(() => clearTimeout(timeout));
}
