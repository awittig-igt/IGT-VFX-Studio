/**
 * project-manager.js
 *
 * Lets the user pick a local Unity project folder (File System Access API),
 * scan it for effects client-side, then commit the assets + manifest directly
 * to the centralized GitHub repo via the GitHub Contents API.
 */

// ── Constants ─────────────────────────────────────────────────────────────
const IGNORE_DIRS = new Set([
  'Library', 'Temp', 'Build', 'Builds', 'Logs',
  'UserSettings', 'obj', 'node_modules', '.git', '__pycache__'
]);
const EFFECT_EXTS = new Set([
  'prefab', 'shader', 'shadergraph', 'shadersubgraph', 'hlsl', 'cginc', 'vfx', 'mat'
]);
const AUTO_TAGS = [
  'fire','water','smoke','explosion','spark','glow','laser','magic',
  'blood','impact','trail','dust','snow','rain','electricity','shield',
  'portal','fog','bubble','stars','hit','burst','flash','flame','ice',
  'wind','lightning','energy','heal','poison','dark','light','holy'
];
// GitHub Contents API hard limit. Files over this are skipped during scan.
const GH_MAX_BYTES = 750000;

// ── ProjectManager ────────────────────────────────────────────────────────
class ProjectManager {
  constructor() {
    this.dirHandle = null;
    this.gameName  = '';
    this.effects   = [];
  }

  // ── Step 1: pick folder ───────────────────────────────────────────────
  async pickFolder() {
    if (!('showDirectoryPicker' in window)) {
      throw new Error('File System Access API not supported. Please use Chrome 86+ or Edge 86+.');
    }
    this.dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    return this.dirHandle.name;
  }

  // ── Step 2: scan project ──────────────────────────────────────────────
  async scan(gameName, onProgress) {
    if (!this.dirHandle) throw new Error('No folder selected.');
    this.gameName = gameName;
    this.effects  = [];

    let checked = 0;
    for await (const { name, path, handle } of walkDir(this.dirHandle)) {
      checked++;
      const ext = name.split('.').pop().toLowerCase();
      if (!EFFECT_EXTS.has(ext)) continue;

      try {
        const file = await handle.getFile();
        if (file.size > GH_MAX_BYTES) continue; // skip files over GitHub limit
        const content = await file.text();
        const effect  = parseEffect(content, path, ext);
        if (effect) this.effects.push(effect);
      } catch { /* skip unreadable files */ }

      if (checked % 25 === 0) onProgress?.(checked, this.effects.length);
    }
    onProgress?.(checked, this.effects.length);
    return this.effects;
  }

  // ── Step 3: push to GitHub ────────────────────────────────────────────
  async push(onProgress) {
    const cfg = getConfig();
    if (!cfg.repo)  throw new Error('No repo configured. Open Settings.');
    if (!cfg.token) throw new Error('A GitHub token with repo scope is required. Add one in Settings.');

    // Resolve the actual branch to use (handles main vs master etc.)
    const branch        = await resolveBranch(cfg);
    const cfgWithBranch = { ...cfg, branch };

    const safeGame = this.gameName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const total    = this.effects.length;

    // Fetch repo tree for SHA lookups (1 request)
    const tree = await fetchRepoTree(cfgWithBranch);

    // Load existing manifest via Contents API (works for private org repos)
    let manifest    = { version: '1.0.0', generatedAt: new Date().toISOString(), effects: [] };
    let manifestSha = null;
    try {
      const mRes = await fetch(
        `https://api.github.com/repos/${cfg.repo}/contents/manifest.json?ref=${branch}`,
        { headers: _ghHeaders(cfg) }
      );
      if (mRes.ok) {
        const mData  = await mRes.json();
        manifestSha  = mData.sha;
        const parsed = JSON.parse(atob(mData.content.replace(/\n/g, '')));
        manifest = { ...parsed, effects: Array.isArray(parsed.effects) ? parsed.effects : [] };
      }
    } catch { /* no manifest yet — start fresh */ }

    // Upload each effect file (non-fatal per-file errors)
    const errors = [];
    for (let i = 0; i < this.effects.length; i++) {
      const effect   = this.effects[i];
      const ext      = effect.relativePath.split('.').pop();
      const fStem    = effect.relativePath.split('/').pop().replace('.' + ext, '');
      const typeDir  = { particle:'particles', shader:'shaders', vfx:'vfx', material:'materials' }[effect.type];
      const destPath = 'assets/' + safeGame + '/' + typeDir + '/' + fStem + '/' + fStem + '.' + ext;

      try {
        await githubPutFile(cfgWithBranch, destPath, effect.content, tree[destPath] || null);

        const id    = makeEffectId(this.gameName, effect.relativePath);
        const entry = {
          id,
          name:         effect.name,
          type:         effect.type,
          game:         this.gameName,
          importSource: 'project-scan',
          originalPath: effect.relativePath,
          files:        { main: destPath, thumbnail: null },
          metadata:     effect.metadata,
          tags:         Array.from(new Set([effect.type, safeGame].concat(autoTagsFor(effect.name)))),
          extractedAt:  new Date().toISOString()
        };
        manifest.effects = manifest.effects.filter(function(e) { return e.id !== id; });
        manifest.effects.push(entry);
      } catch (err) {
        errors.push(effect.name + ': ' + err.message);
        console.error('[effects-extractor] upload failed:', destPath, err);
      }

      onProgress?.(i + 1, total, effect.name);
      if ((i + 1) % 10 === 0) await sleep(250);
    }

    // Commit updated manifest
    manifest.effects.sort(function(a, b) { return a.name.localeCompare(b.name); });
    manifest.generatedAt = new Date().toISOString();
    await githubPutFile(cfgWithBranch, 'manifest.json',
                        JSON.stringify(manifest, null, 2), manifestSha);

    return { total: manifest.effects.length, pushed: total - errors.length, errors: errors };
  }

  summary() {
    const counts = { particle: 0, shader: 0, vfx: 0, material: 0 };
    for (const e of this.effects) counts[e.type] = (counts[e.type] || 0) + 1;
    return counts;
  }

  // ── Load Collected Effects: save to local server folder ─────────────────
  async loadCollectedEffects(onProgress) {
    const safeGame = this.gameName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const cfg      = getConfig();

    // Try to merge with any existing manifest from GitHub or local server
    let manifest = { version: '1.0.0', generatedAt: new Date().toISOString(), effects: [] };
    // Try local server first
    try {
      const r = await fetch('/local/manifest.json');
      if (r.ok) {
        const m = await r.json();
        if (Array.isArray(m.effects)) manifest = m;
      }
    } catch {}
    // Also try GitHub raw URL
    if (cfg.repo && !(manifest.effects || []).length) {
      try {
        const raw    = await fetchFileContent('manifest.json');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.effects)) manifest = parsed;
      } catch {}
    }

    const total = this.effects.length;
    const files = [];   // asset files to send to server

    for (let i = 0; i < total; i++) {
      const effect   = this.effects[i];
      const ext      = effect.relativePath.split('.').pop();
      const fileStem = effect.relativePath.split('/').pop().replace('.' + ext, '');
      const typeDir  = { particle:'particles', shader:'shaders', vfx:'vfx', material:'materials' }[effect.type];
      const destPath = 'assets/' + safeGame + '/' + typeDir + '/' + fileStem + '/' + fileStem + '.' + ext;

      files.push({ path: destPath, content: effect.content });

      const id    = makeEffectId(this.gameName, effect.relativePath);
      const entry = {
        id,
        name:         effect.name,
        type:         effect.type,
        game:         this.gameName,
        importSource: 'project-scan',
        originalPath: effect.relativePath,
        files:        { main: destPath, thumbnail: null },
        metadata:     effect.metadata,
        tags:         Array.from(new Set([effect.type, safeGame].concat(autoTagsFor(effect.name)))),
        extractedAt:  new Date().toISOString()
      };
      manifest.effects = manifest.effects.filter(function(e) { return e.id !== id; });
      manifest.effects.push(entry);

      onProgress?.(i + 1, total, effect.name);
    }

    manifest.effects.sort(function(a, b) { return a.name.localeCompare(b.name); });
    manifest.generatedAt = new Date().toISOString();

    // Save to local server folder via POST /api/save-effects
    const res = await fetch('/api/save-effects', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ manifest: manifest, files: files })
    });
    if (!res.ok) {
      const e = await res.json().catch(function() { return {}; });
      throw new Error('Server error saving effects: ' + (e.error || res.statusText));
    }
    const result = await res.json();

    // Also cache in localStorage so gallery works even if server restarts
    saveLocalManifest(manifest);

    return { total: manifest.effects.length, saved: total, localFolder: result.localFolder };
  }

  async downloadZip(onProgress) {
    await ensureJSZip();
    const zip      = new JSZip();
    const cfg      = getConfig();
    const safeGame = this.gameName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    // Try to merge with any existing manifest from the repo (best-effort)
    let manifest = { version: '1.0.0', generatedAt: new Date().toISOString(), effects: [] };
    if (cfg.repo) {
      try {
        const raw    = await fetchFileContent('manifest.json');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.effects)) manifest = parsed;
      } catch { /* no existing manifest or can't reach it — start fresh */ }
    }

    const total = this.effects.length;
    for (let i = 0; i < total; i++) {
      const effect   = this.effects[i];
      const ext      = effect.relativePath.split('.').pop();
      const fileStem = effect.relativePath.split('/').pop().replace('.' + ext, '');
      const typeDir  = { particle:'particles', shader:'shaders', vfx:'vfx', material:'materials' }[effect.type];
      const destPath = 'assets/' + safeGame + '/' + typeDir + '/' + fileStem + '/' + fileStem + '.' + ext;

      zip.file(destPath, effect.content);

      const id    = makeEffectId(this.gameName, effect.relativePath);
      const entry = {
        id,
        name:         effect.name,
        type:         effect.type,
        game:         this.gameName,
        importSource: 'project-scan',
        originalPath: effect.relativePath,
        files:        { main: destPath, thumbnail: null },
        metadata:     effect.metadata,
        tags:         Array.from(new Set([effect.type, safeGame].concat(autoTagsFor(effect.name)))),
        extractedAt:  new Date().toISOString()
      };
      manifest.effects = manifest.effects.filter(function(e) { return e.id !== id; });
      manifest.effects.push(entry);

      onProgress?.(i + 1, total, effect.name);
    }

    manifest.effects.sort(function(a, b) { return a.name.localeCompare(b.name); });
    manifest.generatedAt = new Date().toISOString();
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    // Save to sessionStorage so the gallery shows immediately — no git push needed first
    saveLocalManifest(manifest);

    // Trigger browser download
    const blob     = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const url      = URL.createObjectURL(blob);
    const anchor   = document.createElement('a');
    anchor.href    = url;
    anchor.download = 'effects-' + safeGame + '.zip';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(function() { URL.revokeObjectURL(url); }, 2000);

    return manifest.effects.length;
  }
}

// ── File walker (async generator) ─────────────────────────────────────────
async function* walkDir(dirHandle, path) {
  path = path || '';
  for await (const [name, entry] of dirHandle) {
    const fullPath = path ? path + '/' + name : name;
    if (entry.kind === 'directory') {
      if (!IGNORE_DIRS.has(name)) {
        try { yield* walkDir(entry, fullPath); } catch { /* skip inaccessible dirs */ }
      }
    } else {
      yield { name: name, path: fullPath, handle: entry };
    }
  }
}

// ── Asset parsers ─────────────────────────────────────────────────────────
function parseEffect(content, relativePath, ext) {
  if (ext === 'prefab') {
    if (!content.includes('ParticleSystem:')) return null;
    return parseParticlePrefab(content, relativePath);
  }
  if (ext === 'shader' || ext === 'shadergraph' || ext === 'shadersubgraph' ||
      ext === 'hlsl'   || ext === 'cginc') {
    return parseShaderFile(content, relativePath, ext);
  }
  if (ext === 'vfx')  return { type:'vfx',      name:fileStem(relativePath), relativePath, content, metadata:{} };
  if (ext === 'mat')  return { type:'material',  name:fileStem(relativePath), relativePath, content, metadata:{} };
  return null;
}

function parseParticlePrefab(content, relativePath) {
  let name = null;
  const goMatch = content.match(/^GameObject:\s*\n(?:(?!^---)[^\n]*\n)*?.*?m_Name:\s*(.+)/m);
  if (goMatch) name = goMatch[1].trim();

  const psStart = content.indexOf('\nParticleSystem:');
  let metadata = {};
  if (psStart !== -1) {
    const psEnd = content.indexOf('\n--- ', psStart + 1);
    const sec   = psEnd === -1 ? content.slice(psStart) : content.slice(psStart, psEnd);
    metadata = {
      duration:        parseFloat(extractVal(sec, 'lengthInSec'))  || 5,
      looping:         parseInt(extractVal(sec, 'looping'))        === 1,
      maxParticles:    parseInt(extractVal(sec, 'maxNumParticles')) || 1000,
      startLifetime:   parseMMCurve(sec, 'startLifetime', 2),
      startSpeed:      parseMMCurve(sec, 'startSpeed', 3),
      startSize:       parseMMCurve(sec, 'startSize', 0.3),
      gravityModifier: parseMMCurve(sec, 'gravityModifier', 0),
      startColor:      parseColor(sec),
      emission:        parseEmission(sec),
      shape:           parseShape(sec)
    };
  }
  return { type:'particle', name: name || fileStem(relativePath), relativePath, content, metadata };
}

function parseShaderFile(content, relativePath, ext) {
  let name = null;
  const props = [], tags = {};
  if (ext === 'shadergraph') {
    try { name = JSON.parse(content).m_Name || null; } catch { /* ok */ }
  } else {
    const nm = content.match(/^\s*Shader\s+"([^"]+)"/m);
    if (nm) name = nm[1];
    const propsBlock = content.match(/Properties\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/s);
    if (propsBlock) {
      const rx = /(\w+)\s*\("([^"]+)",\s*([\w()]+)\)/g; let m;
      while ((m = rx.exec(propsBlock[1])) !== null)
        props.push({ name:m[1], displayName:m[2], type:m[3] });
    }
    const tagsBlock = content.match(/Tags\s*\{([^}]+)\}/);
    if (tagsBlock) {
      const rx = /"(\w+)"\s*=\s*"([^"]+)"/g; let m;
      while ((m = rx.exec(tagsBlock[1])) !== null) tags[m[1]] = m[2];
    }
  }
  return {
    type: 'shader',
    name: name || fileStem(relativePath),
    relativePath, content,
    metadata: {
      properties:    props,
      tags:          tags,
      renderQueue:   (content.match(/"Queue"\s*=\s*"([^"]+)"/) || [])[1] || null,
      isShaderGraph: ext === 'shadergraph',
      hasHLSL:       /HLSLPROGRAM|HLSLINCLUDE/.test(content),
      hasCGPROGRAM:  /CGPROGRAM/.test(content)
    }
  };
}

// Prefab sub-parsers
function parseMMCurve(sec, key, fallback) {
  const rx = new RegExp(key + '[\\s\\S]{1,60}?minMaxState: (\\d)[\\s\\S]{1,60}?scalar: ([\\d.e+-]+)', 'm');
  const m  = sec.match(rx);
  if (!m) {
    const s = sec.match(new RegExp('^\\s*' + key + ':\\s*([\\d.e+-]+)', 'm'));
    return s ? { type:'constant', value:parseFloat(s[1]) } : { type:'constant', value:fallback };
  }
  const state = parseInt(m[1]), scalar = parseFloat(m[2]);
  if (state === 2) {
    const mm = sec.match(new RegExp(key + '[\\s\\S]{1,100}?minScalar: ([\\d.e+-]+)', 'm'));
    return { type:'randomBetweenTwoConstants', min: mm ? parseFloat(mm[1]) : scalar, max: scalar };
  }
  return { type:'constant', value:scalar };
}
function parseColor(sec) {
  const keys = ['maxColor','minColor','m_Color'];
  for (let i = 0; i < keys.length; i++) {
    const m = sec.match(new RegExp(
      keys[i] + ':\\s*\\{r:\\s*([\\d.]+),\\s*g:\\s*([\\d.]+),\\s*b:\\s*([\\d.]+),\\s*a:\\s*([\\d.]+)\\}'));
    if (m) return { r:+m[1], g:+m[2], b:+m[3], a:+m[4] };
  }
  return { r:1, g:1, b:1, a:1 };
}
function parseEmission(sec) {
  const s = sec.indexOf('EmissionModule:');
  if (s === -1) return { enabled:true, rateOverTime:10 };
  const m = sec.slice(s, s + 400).match(/rateOverTime:[\s\S]{1,60}?scalar: ([\d.e+-]+)/m);
  return { enabled:true, rateOverTime: m ? parseFloat(m[1]) : 10 };
}
const SHAPE_MAP = { 0:'sphere',1:'hemisphere',2:'cone',4:'box',7:'circle',8:'edge',10:'cone',11:'donut' };
function parseShape(sec) {
  const s = sec.indexOf('ShapeModule:');
  if (s === -1) return { type:'cone', radius:1, angle:25 };
  const chunk = sec.slice(s, s + 500);
  const t = chunk.match(/shapeType: (\d+)/);
  const r = chunk.match(/radius: ([\d.e+-]+)/);
  const a = chunk.match(/angle: ([\d.e+-]+)/);
  return {
    type:   t ? (SHAPE_MAP[parseInt(t[1])] || 'cone') : 'cone',
    radius: r ? +r[1] : 1,
    angle:  a ? +a[1] : 25
  };
}
function extractVal(content, key) {
  const m = content.match(new RegExp('^\\s*' + key + ':\\s*(.+)$', 'm'));
  return m ? m[1].trim() : null;
}

// ── GitHub API helpers ─────────────────────────────────────────────────────
async function resolveBranch(cfg) {
  const configured = cfg.branch || 'main';
  try {
    const testRes = await fetch(
      'https://api.github.com/repos/' + cfg.repo + '/git/refs/heads/' + configured,
      { headers: _ghHeaders(cfg) }
    );
    if (testRes.ok) return configured;
    // Branch not found — ask the repo what its default branch is
    const repoRes  = await fetch('https://api.github.com/repos/' + cfg.repo, { headers: _ghHeaders(cfg) });
    if (repoRes.ok) {
      const repoData = await repoRes.json();
      return repoData.default_branch || configured;
    }
  } catch { /* network issue — proceed with configured branch */ }
  return configured;
}

async function fetchRepoTree(cfg) {
  try {
    const url = 'https://api.github.com/repos/' + cfg.repo + '/git/trees/' + cfg.branch + '?recursive=1';
    const res = await fetch(url, { headers: _ghHeaders(cfg) });
    if (!res.ok) return {};
    const data  = await res.json();
    const tree  = {};
    const items = data.tree || [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type === 'blob') tree[items[i].path] = items[i].sha;
    }
    return tree;
  } catch {
    return {}; // network blocked — proceed without SHA cache (will retry on 422)
  }
}

/**
 * Create or update one file via the GitHub Contents API.
 * NOTE: `path` must contain literal '/' characters — do NOT
 * run it through encodeURIComponent or the slashes become %2F
 * and GitHub returns 404/422.
 */
async function githubPutFile(cfg, path, textContent, existingSha) {
  const b64 = btoa(unescape(encodeURIComponent(textContent)));
  const url  = 'https://api.github.com/repos/' + cfg.repo + '/contents/' + path;
  const body = {
    message: 'effects-extractor: add ' + path,
    content: b64,
    branch:  cfg.branch
  };
  if (existingSha) body.sha = existingSha;

  let res;
  try {
    res = await fetch(url, {
      method:  'PUT',
      headers: Object.assign({}, _ghHeaders(cfg), { 'Content-Type': 'application/json' }),
      body:    JSON.stringify(body)
    });
  } catch {
    throw new Error('Network error uploading ' + path + '. Check internet connection or firewall.');
  }

  // 409 / 422 = SHA conflict — fetch the real current SHA and retry once
  if (res.status === 409 || res.status === 422) {
    try {
      const check = await fetch(url, { headers: _ghHeaders(cfg) });
      if (check.ok) {
        body.sha = (await check.json()).sha;
        res = await fetch(url, {
          method:  'PUT',
          headers: Object.assign({}, _ghHeaders(cfg), { 'Content-Type': 'application/json' }),
          body:    JSON.stringify(body)
        });
      }
    } catch { /* ignore retry failure — fall through to error check */ }
  }

  if (!res.ok) {
    const e = await res.json().catch(function() { return {}; });
    const hint = res.status === 401 ? ' (invalid or expired token — check Settings)'
               : res.status === 403 ? ' (token lacks write permission to this repo)'
               : res.status === 404 ? ' (repo or branch not found — check Settings)'
               : '';
    throw new Error('GitHub ' + res.status + hint + ': ' + (e.message || res.statusText) + ' (' + path + ')');
    throw new Error('GitHub ' + res.status + ': ' + (e.message || res.statusText) + ' (' + path + ')');
  }
}

function _ghHeaders(cfg) {
  return {
    Authorization: 'Bearer ' + cfg.token,
    Accept:        'application/vnd.github.v3+json'
  };
}

// ── Utility ───────────────────────────────────────────────────────────────
function fileStem(path) {
  const base = path.split('/').pop();
  const dot  = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
function autoTagsFor(name) {
  const l = name.toLowerCase();
  return AUTO_TAGS.filter(function(k) { return l.indexOf(k) !== -1; });
}
function makeEffectId(game, relPath) {
  const str = game + ':' + relPath;
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  const hash = (h >>> 0).toString(16).padStart(8, '0');
  const name = fileStem(relPath).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const g    = game.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return name + '-' + g + '-' + hash;
}
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function ensureJSZip(timeoutMs) {
  timeoutMs = timeoutMs || 10000;
  if (typeof JSZip !== 'undefined') return Promise.resolve();

  return new Promise(function(resolve, reject) {
    const started = Date.now();
    const timer = setInterval(function() {
      if (typeof JSZip !== 'undefined') {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error('The ZIP library could not be loaded. Check your internet connection and try again.'));
      }
    }, 100);
  });
}

// ── UI controller ─────────────────────────────────────────────────────────
;(function initAddProject() {
  const mgr  = new ProjectManager();
  const modal  = function() { return document.getElementById('modal-add-project'); };
  const el     = function(id) { return document.getElementById(id); };
  const STEPS  = ['config','scanning','review','pushing','done'];
  let serverSourceProjectPath = '';
  let serverPreviewProjectPath = '';
  let serverSourceProjectValid = false;
  let serverPreviewProjectValid = false;
  let serverSourceProjectValidation = null;
  let serverPreviewProjectValidation = null;
  let serverExtractionAvailable = false;
  let serverExtractionError = '';

  const RESTART_SERVER_MESSAGE =
    'This browser tab is connected to an older Effects Extractor server. ' +
    'Stop the old server, run .\\serve.ps1 again, and open the URL printed by the new server.';

  function formatProjectValidation(validation, fallback, validMessage) {
    if (!validation) return fallback;
    const reasons = Array.isArray(validation.reasons)
      ? validation.reasons.filter(Boolean)
      : [];
    if (!validation.valid) {
      return reasons.length ? reasons.join(' ') : fallback;
    }
    const version = validation.editorVersion ? ' (project Unity ' + validation.editorVersion + ')' : '';
    const editorMatch = validation.compatibleEditorVersion
      ? ' Using installed Unity ' + validation.compatibleEditorVersion +
        (validation.editorFamilyExemptionUsed
          ? ' through the ' + validation.editorVersionFamily + ' family exemption.'
          : ' as an exact match.')
      : '';
    return (validMessage || 'Valid Unity project') + version +
      '. Required folders and ProjectVersion.txt are readable.' + editorMatch;
  }

  function logProjectValidation(label, validation) {
    if (!validation) return;
    const method = validation.valid ? 'info' : 'error';
    console[method]('[effects-extractor] ' + label + ' validation details:', validation);
    if (!validation.valid && Array.isArray(validation.reasons)) {
      validation.reasons.forEach(function(reason) {
        console.error('[effects-extractor] ' + label + ' validation failure: ' + reason);
      });
    }
  }

  function showStep(name) {
    for (let i = 0; i < STEPS.length; i++) {
      const s = el('add-step-' + STEPS[i]);
      if (s) s.classList.add('hidden');
    }
    const step = el('add-step-' + name);
    if (step) step.classList.remove('hidden');
    const userFacing = ['config','review','done'];
    const idx = userFacing.indexOf(name);
    el('add-step-indicator').textContent = idx >= 0 ? 'Step ' + (idx+1) + ' of 3' : '';
  }

  async function openModal() {
    mgr.dirHandle = null;
    mgr.effects   = [];
    el('add-game-name').value        = '';
    el('folder-display').textContent = 'No folder selected';
    el('btn-start-scan').disabled    = true;
    el('api-warning').classList.add('hidden');
    showStep('config');
    modal().classList.remove('hidden');
    if (!('showDirectoryPicker' in window)) el('api-warning').classList.remove('hidden');
    await refreshServerProjectPath(true);
    updateActionButtons();
  }
  function closeModal() { modal().classList.add('hidden'); }

  async function refreshServerProjectPath(prefillName) {
    let error = '';
    serverExtractionAvailable = false;
    serverExtractionError = '';
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      if (!response.ok) throw new Error('Server configuration is unavailable.');
      const config = await response.json();
      serverSourceProjectPath = config.sourceProjectPath || '';
      serverPreviewProjectPath = config.previewProjectPath || config.unityProjectPath || '';
      if (el('add-source-unity-path')) {
        el('add-source-unity-path').value = serverSourceProjectPath;
      }
      serverSourceProjectValid = config.sourceProjectValid === true;
      serverPreviewProjectValid = config.previewProjectValid === true;
      serverSourceProjectValidation = config.sourceProjectValidation || null;
      serverPreviewProjectValidation = config.previewProjectValidation || null;
      logProjectValidation('Source Game Project', serverSourceProjectValidation);
      logProjectValidation('Preview Container', serverPreviewProjectValidation);
      serverExtractionAvailable = Boolean(
        Number(config.apiVersion) >= 4 &&
        config.capabilities &&
        config.capabilities.projectExtraction === true &&
        config.capabilities.separateSourceAndPreview === true &&
        config.capabilities.sanitizedParticlePackages === true &&
        config.capabilities.disposablePreviewWorkspace === true
      );
      if (!serverExtractionAvailable) serverExtractionError = RESTART_SERVER_MESSAGE;
      else if (!serverSourceProjectPath) {
        serverExtractionError = 'Enter the source game project path above.';
      } else if (config.sourceProjectValid !== true) {
        serverExtractionError = formatProjectValidation(
          serverSourceProjectValidation,
          'The source path is not a valid Unity project.'
        );
      } else if (!serverPreviewProjectPath || config.previewProjectValid !== true) {
        serverExtractionError = formatProjectValidation(
          serverPreviewProjectValidation,
          'The preview container path is not a valid Unity project.'
        );
      } else if (serverSourceProjectPath.toLowerCase() === serverPreviewProjectPath.toLowerCase()) {
        serverExtractionError = 'The source game project and preview container must be different folders.';
      }
    } catch (exception) {
      serverSourceProjectPath = '';
      serverPreviewProjectPath = '';
      serverSourceProjectValid = false;
      serverPreviewProjectValid = false;
      serverSourceProjectValidation = null;
      serverPreviewProjectValidation = null;
      error = exception.message || 'Server is not responding.';
      serverExtractionError = error;
    }

    if (el('review-unity-path')) {
      el('review-unity-path').textContent = serverSourceProjectPath || error || 'Not configured';
      el('review-unity-path').title = serverSourceProjectPath;
    }
    if (el('review-unity-ready')) {
      const ready = Boolean(serverSourceProjectPath && serverExtractionAvailable && serverSourceProjectValid);
      el('review-unity-ready').textContent = ready ? 'Ready' : 'Not ready';
      el('review-unity-ready').classList.toggle('not-ready', !ready);
      el('review-unity-ready').title = ready ? '' : serverExtractionError;
    }
    ['add-preview-unity-path', 'review-preview-unity-path'].forEach(function(id) {
      if (el(id)) {
        el(id).textContent = serverPreviewProjectPath || 'Not configured';
        el(id).title = serverPreviewProjectPath;
      }
    });
    ['add-preview-unity-ready', 'review-preview-unity-ready'].forEach(function(id) {
      if (!el(id)) return;
      const ready = Boolean(serverPreviewProjectPath && serverExtractionAvailable && serverPreviewProjectValid);
      el(id).textContent = ready ? 'Ready' : 'Not ready';
      el(id).classList.toggle('not-ready', !ready);
      el(id).title = ready ? '' : serverExtractionError;
    });
    if (el('review-unity-note')) {
      el('review-unity-note').textContent = serverExtractionError ||
        'Unity scans this game project, exports packages, then imports them into the preview container.';
    }
    if (prefillName && serverSourceProjectPath && !el('add-game-name').value.trim()) {
      const parts = serverSourceProjectPath.split(/[\\/]/).filter(Boolean);
      el('add-game-name').value = parts[parts.length - 1] || '';
    }
    renderSourceProjectField(error);
  }

  function normalizeProjectPath(value) {
    return String(value || '').trim().replace(/[\\/]+$/, '').toLowerCase();
  }

  function getSourceProjectInput() {
    return el('add-source-unity-path') ? el('add-source-unity-path').value.trim() : '';
  }

  function renderSourceProjectField(message) {
    const sourcePath = getSourceProjectInput();
    const matchesSavedPath =
      normalizeProjectPath(sourcePath) === normalizeProjectPath(serverSourceProjectPath);
    const sameAsPreview =
      sourcePath && normalizeProjectPath(sourcePath) === normalizeProjectPath(serverPreviewProjectPath);
    const ready = Boolean(
      sourcePath && matchesSavedPath && serverExtractionAvailable && serverSourceProjectValid
    );
    const badge = el('add-server-unity-ready');
    const status = el('add-source-unity-status');

    if (badge) {
      badge.textContent = ready
        ? 'Ready'
        : ((message || matchesSavedPath) ? 'Not ready' : 'Not checked');
      badge.classList.toggle('not-ready', !ready);
      badge.title = ready ? '' : (message || serverExtractionError);
    }
    if (status) {
      if (message) {
        status.textContent = message;
      } else if (!serverExtractionAvailable) {
        status.textContent = serverExtractionError || RESTART_SERVER_MESSAGE;
      } else if (!sourcePath) {
        status.textContent = 'Enter the Unity game project containing Assets and ProjectSettings.';
      } else if (sameAsPreview) {
        status.textContent = 'Choose the game project, not the preview container project.';
      } else if (!matchesSavedPath) {
        status.textContent = 'This path will be validated and saved before extraction starts.';
      } else if (ready) {
        status.textContent = formatProjectValidation(
          serverSourceProjectValidation,
          'Valid Unity game project. Ready to scan and extract.',
          'Valid Unity game project. Ready to scan and extract'
        );
      } else {
        status.textContent = serverExtractionError || 'This is not a valid Unity game project.';
      }
    }
    updateActionButtons();
  }

  function updateActionButtons() {
    const hasName = Boolean(el('add-game-name').value.trim());
    const sourcePath = getSourceProjectInput();
    const sourceDiffersFromPreview =
      normalizeProjectPath(sourcePath) !== normalizeProjectPath(serverPreviewProjectPath);
    const canValidateSource = Boolean(
      sourcePath && serverExtractionAvailable && sourceDiffersFromPreview
    );
    const canExtract = Boolean(
      canValidateSource && serverPreviewProjectPath && serverPreviewProjectValid
    );
    el('btn-start-scan').disabled = !(mgr.dirHandle && hasName);
    el('btn-start-unity-extraction').disabled = !(canExtract && hasName);
    if (el('btn-validate-source-project')) {
      el('btn-validate-source-project').disabled = !canValidateSource;
    }
  }

  document.addEventListener('DOMContentLoaded', function() {
    if (new URLSearchParams(window.location.search).get('findfx') === '1') {
      showExtractionBar(5, 'Preparing FindFX particle previews...', '');
      document.getElementById('extraction-bottom-log-download').classList.remove('hidden');
      pollProjectExtractionJob().then(function() {
        if (typeof loadGallery === 'function') loadGallery();
      }).catch(async function(error) {
        finishExtractionBar(false, error.message);
        await showExtractionErrorLog(error.message);
      });
    }
    document.getElementById('btn-add-project').addEventListener('click', openModal);
    el('btn-close-add-project').addEventListener('click', closeModal);
    el('btn-cancel-add').addEventListener('click', closeModal);
    modal().addEventListener('click', function(e) { if (e.target === modal()) closeModal(); });

    // Pick folder
    el('btn-pick-folder').addEventListener('click', async function() {
      try {
        const name = await mgr.pickFolder();
        el('folder-display').textContent = name;
        updateActionButtons();
      } catch (err) {
        if (err.name !== 'AbortError') el('folder-display').textContent = 'Error: ' + err.message;
      }
    });
    el('add-game-name').addEventListener('input', updateActionButtons);
    el('add-source-unity-path').addEventListener('input', function() {
      renderSourceProjectField();
    });
    el('btn-validate-source-project').addEventListener('click', async function() {
      try {
        await validateSourceProjectPath();
      } catch (_) {
        // Validation feedback is displayed next to the source path.
      }
    });

    // Scan
    el('btn-start-scan').addEventListener('click', async function() {
      showStep('scanning');
      try {
        await mgr.scan(el('add-game-name').value.trim(), function(checked, found) {
          el('scan-status').textContent = 'Scanning prefab and effect assets' + '\u2026';
          el('scan-count').textContent  = checked + ' files checked \u00b7 ' + found + ' effects found';
        });
        await showReview();
      } catch (err) {
        showDone(false, err.message);
      }
    });

    // Review
    async function showReview() {
      showStep('review');
      await refreshServerProjectPath(false);
      const cfg     = getConfig();
      const summary = mgr.summary();
      const total   = Object.values(summary).reduce(function(a,b){ return a+b; }, 0);
      const icons   = { particle:'&#10022;', shader:'&#9672;', vfx:'&#11041;', material:'&#9673;' };

      el('review-repo').textContent = cfg.repo || '(not configured)';

      // file:// warning
      const fileWarn = el('push-file-warning');
      if (fileWarn) fileWarn.classList.toggle('hidden', window.location.protocol !== 'file:');

      el('scan-summary').innerHTML =
        '<p class="summary-total">' + total + ' effect asset' + (total !== 1 ? 's' : '') +
        ' found in <strong>' + escText(mgr.gameName) + '</strong></p>' +
        '<p class="package-candidate-count"><strong>' + summary.particle + '</strong> particle prefab candidate' +
        (summary.particle !== 1 ? 's' : '') + ' ready for dependency resolution and Unity packaging</p>' +
        '<div class="summary-grid">' +
        Object.keys(summary).map(function(type) {
          return '<div class="summary-card type-' + type + '">' +
            '<span class="summary-icon">' + (icons[type] || '') + '</span>' +
            '<span class="summary-count">' + summary[type] + '</span>' +
            '<span class="summary-label">' + type + '</span>' +
            '</div>';
        }).join('') +
        '</div>';

      const hasToken = Boolean(cfg.token);
      el('push-token-warning').classList.toggle('hidden', hasToken);
      el('push-network-warning').classList.add('hidden');
      el('btn-download-zip').disabled = total === 0;

      // Default: Download ZIP is primary, Push is secondary
      // We'll promote Push to primary only if the API is reachable
      setZipPrimary();
      el('btn-push').disabled = !hasToken || total === 0;
      el('btn-run-extraction').disabled = !(
        serverSourceProjectPath && serverPreviewProjectPath &&
        serverExtractionAvailable && !serverExtractionError && summary.particle > 0
      );
      if (!el('btn-run-extraction').disabled) setExtractionPrimary();

      // Probe GitHub API reachability (simple GET, no preflight)
      if (hasToken && total > 0) {
        fetch('https://api.github.com')
          .then(function(r) {
            if (r.ok || r.status < 500) {
              // API is reachable — promote Push to primary
              if (el('btn-run-extraction').disabled) setPushPrimary();
            }
          })
          .catch(function() {
            // API blocked — show warning, keep Download ZIP as primary
            el('push-network-warning').classList.remove('hidden');
          });
      }
    }

    function setPushPrimary() {
      el('btn-push').className        = 'btn-primary';
      el('btn-download-zip').className = 'btn-secondary';
      el('btn-run-extraction').className = 'btn-secondary';
    }
    function setZipPrimary() {
      el('btn-download-zip').className = 'btn-primary';
      el('btn-push').className         = 'btn-secondary';
      el('btn-run-extraction').className = 'btn-secondary';
    }
    function setExtractionPrimary() {
      el('btn-run-extraction').className = 'btn-primary';
      el('btn-push').className = 'btn-secondary';
      el('btn-download-zip').className = 'btn-secondary';
    }

    el('btn-back-config').addEventListener('click', function() { showStep('config'); });

    el('btn-start-unity-extraction').addEventListener('click', startBackendExtraction);
    el('btn-run-extraction').addEventListener('click', startBackendExtraction);

    async function startBackendExtraction() {
      const gameName = el('add-game-name').value.trim();
      const sourcePath = getSourceProjectInput();
      if (!gameName || !sourcePath || !serverPreviewProjectPath) return;
      if (!serverExtractionAvailable) {
        showDone(false, serverExtractionError || RESTART_SERVER_MESSAGE);
        return;
      }
      try {
        await validateSourceProjectPath();
      } catch (_) {
        return;
      }

      // Close the modal and hand off progress tracking to the fixed bottom bar.
      closeModal();
      showExtractionBar(5, 'Starting Unity project extraction…', serverSourceProjectPath);

      try {
        const response = await fetch('/api/project-extraction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gameName: gameName })
        });
        const result = await readServerJson(response, 'The server could not start project extraction.');
        if (!response.ok || !result.ok) {
          throw new Error(result.error || 'The server could not start project extraction.');
        }
        document.getElementById('extraction-bottom-log-download').classList.remove('hidden');
        await refreshExtractionLogs();
        await pollProjectExtractionJob();
      } catch (error) {
        if (error.payload && error.payload.logAvailable) {
          document.getElementById('extraction-bottom-log-download').classList.remove('hidden');
        }
        finishExtractionBar(false, error.message);
        await showExtractionErrorLog(error.message);
      }
    }

    async function validateSourceProjectPath() {
      const sourcePath = getSourceProjectInput();
      if (!sourcePath) {
        const error = new Error('Enter the source game project path.');
        renderSourceProjectField(error.message);
        throw error;
      }

      const validateButton = el('btn-validate-source-project');
      const extractButton = el('btn-start-unity-extraction');
      const badge = el('add-server-unity-ready');
      const status = el('add-source-unity-status');
      validateButton.disabled = true;
      extractButton.disabled = true;
      badge.textContent = 'Checking';
      badge.classList.add('not-ready');
      status.textContent = 'Validating the Unity project with the local server...';

      try {
        const response = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceProjectPath: sourcePath })
        });
        const result = await readServerJson(response, 'The server could not validate the source project.');
        if (!response.ok || !result.ok) {
          throw new Error(result.error || 'The source game project is invalid.');
        }
        await refreshServerProjectPath(true);
        if (!serverSourceProjectValid) {
          throw new Error('The source path is not a valid Unity project.');
        }
        renderSourceProjectField();
        return true;
      } catch (error) {
        serverSourceProjectValid = false;
        const validation = error.payload && error.payload.validation;
        if (validation) {
          serverSourceProjectValidation = validation;
          logProjectValidation('Source Game Project', validation);
        }
        serverExtractionError = formatProjectValidation(
          validation,
          error.message || 'Could not validate the source game project.'
        );
        renderSourceProjectField(serverExtractionError);
        throw error;
      } finally {
        updateActionButtons();
      }
    }

    async function pollProjectExtractionJob() {
      const phaseLabels = {
        queued:  'Waiting for the Unity worker',
        prepare: 'Preparing automation scripts',
        export:  'Scanning scenes and prefab roots, then resolving dependencies',
        import:  'Importing packages into the preview container',
        capture: 'Simulating particles and rendering previews',
        publish: 'Publishing packages and previews to the gallery',
        complete: 'Extraction complete'
      };
      const deadline = Date.now() + 45 * 60 * 1000;
      while (Date.now() < deadline) {
        const response = await fetch('/api/project-extraction-job', { cache: 'no-store' });
        const job = await readServerJson(response, 'Could not read the extraction job status.');

        var counts =
          '<span>' + (job.exportCount || 0) + ' packages</span>' +
          '<span>' + (job.captureCount || 0) + ' previews</span>' +
          '<span>' + (job.libraryCount || 0) + ' published</span>';
        updateExtractionBar(
          Math.max(5, job.progress || 0),
          job.message || 'Unity is working…',
          phaseLabels[job.phase] || serverSourceProjectPath,
          counts
        );
        await refreshExtractionLogs();

        if (job.state === 'failed') {
          throw new Error(job.message || 'Unity project extraction failed.');
        }
        if (job.state === 'complete') {
          var warnings = Array.isArray(job.warnings) && job.warnings.length
            ? ' — Warnings: ' + job.warnings.slice(0, 3).join('; ')
            : '';
          finishExtractionBar(true,
            (job.libraryCount || 0) + ' package(s) and ' +
            (job.captureCount || 0) + ' preview(s) published to the gallery.' + warnings);
          return;
        }
        await new Promise(function(resolve) { setTimeout(resolve, 1500); });
      }
      throw new Error('Unity did not finish within 45 minutes. Check the extraction job logs.');
    }

    async function readServerJson(response, fallbackMessage) {
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType.indexOf('application/json') === -1) {
        throw new Error(contentType.indexOf('text/html') !== -1
          ? RESTART_SERVER_MESSAGE
          : fallbackMessage + ' The server returned an unexpected response.');
      }

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new Error(fallbackMessage + ' The server returned invalid JSON.');
      }
      if (!response.ok) {
        const serverError = new Error(payload.error || fallbackMessage);
        serverError.payload = payload;
        throw serverError;
      }
      return payload;
    }

    // Load Collected Effects
    el('btn-download-zip').addEventListener('click', async function() {
      showStep('pushing');
      el('push-progress-bar').style.width = '0%';
      el('push-status').textContent = 'Saving effects...';
      el('push-file').textContent   = '';
      el('extraction-progress-details').classList.add('hidden');
      el('btn-done-reload').style.display = '';

      try {
        const result = await mgr.loadCollectedEffects(function(done, total, name) {
          el('push-progress-bar').style.width = Math.round((done / total) * 100) + '%';
          el('push-status').textContent = 'Saving ' + done + ' / ' + total + '...';
          el('push-file').textContent   = name;
        });
        showDone(true, result.saved + ' effect(s) saved to:\n' + (result.localFolder || 'local-effects/'));
      } catch (err) {
        showDone(false, err.message);
      }
    });

    // Push
    el('btn-push').addEventListener('click', async function() {
      showStep('pushing');
      el('push-progress-bar').style.width = '0%';
      el('push-status').textContent = 'Connecting\u2026';
      el('push-file').textContent   = '';
      el('extraction-progress-details').classList.add('hidden');
      el('btn-done-reload').style.display = ''; // ensure visible for push flow

      try {
        const result = await mgr.push(function(done, total, name) {
          el('push-progress-bar').style.width = Math.round((done / total) * 100) + '%';
          el('push-status').textContent = 'Pushing ' + done + ' / ' + total + '\u2026';
          el('push-file').textContent   = name;
        });

        if (result.errors.length === 0) {
          showDone(true,
            result.pushed + ' file(s) committed \u2014 manifest now has ' + result.total + ' effects.');
        } else {
          showDone('partial',
            result.pushed + ' succeeded, ' + result.errors.length + ' failed:\n' +
            result.errors.slice(0, 5).join('\n'));
        }
      } catch (err) {
        // Surface network errors and suggest Download ZIP as fallback
        const netErr = err.message.indexOf('Network error') !== -1 || err.message.indexOf('firewall') !== -1;
        showDone(false, err.message + (netErr ? '\n\nTip: use Download ZIP instead and push with git.' : ''));
        if (netErr) el('push-network-warning').classList.remove('hidden');
      }
    });

    // Done
    function showDone(success, msg) {
      showStep('done');
      var icon = success === true ? '\u2713' : success === 'partial' ? '\u26a0' : '\u2715';
      var cls  = success === true ? 'done-ok' : success === 'partial' ? 'done-warn' : 'done-err';
      var head = success === true ? 'All done!'
               : success === 'partial' ? 'Partially pushed'
               : 'Something went wrong';
      el('done-icon').textContent = icon;
      el('done-icon').className   = 'done-icon ' + cls;
      el('done-msg').textContent  = head;
      el('done-sub').innerHTML    = escText(msg || '').replace(/\n/g, '<br>');
    }

    el('btn-done-reload').addEventListener('click', function() {
      closeModal();
      if (typeof loadGallery === 'function') loadGallery();
    });
    el('btn-done-close').addEventListener('click', closeModal);
  });

  // ── Bottom extraction bar helpers ────────────────────────────────────────
  var extractionLogSections = new Map();
  var extractionLogGeneration = 0;
  var extractionLogFetching = false;

  function setExtractionLogsExpanded(expanded) {
    var button = document.getElementById('extraction-bottom-expand');
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', expanded ? 'Collapse extraction logs' : 'Expand extraction logs');
    button.title = expanded ? 'Collapse extraction logs' : 'Expand extraction logs';
    document.getElementById('extraction-bottom-diagnostics').classList.toggle('hidden', !expanded);
    document.getElementById('extraction-bottom-logs').open = expanded;
    if (expanded) refreshExtractionLogs();
  }

  function showExtractionBar(pct, status, detail) {
    var bar = document.getElementById('extraction-bottom-bar');
    if (!bar) return;
    bar.classList.remove('hidden');
    document.getElementById('extraction-bottom-icon').className = 'extraction-bottom-icon';
    document.getElementById('extraction-bottom-icon').textContent = '\u27f3';
    document.getElementById('extraction-bottom-status').textContent = status || '';
    document.getElementById('extraction-bottom-detail').textContent = detail || '';
    document.getElementById('extraction-bottom-fill').style.width = (pct || 0) + '%';
    document.getElementById('extraction-bottom-counts').innerHTML = '';
    document.getElementById('extraction-bottom-reload').classList.add('hidden');
    document.getElementById('extraction-bottom-log-download').classList.add('hidden');
    document.getElementById('extraction-bottom-errors').classList.add('hidden');
    document.getElementById('extraction-bottom-errors').open = false;
    document.getElementById('extraction-bottom-error-text').textContent = '';
    setExtractionLogsExpanded(false);
    extractionLogGeneration++;
    extractionLogFetching = false;
    extractionLogSections.clear();
    document.getElementById('extraction-bottom-log-sections').replaceChildren();
    document.getElementById('extraction-bottom-logs').classList.remove('hidden');
    document.getElementById('extraction-bottom-logs-summary').textContent = 'Steps & logs';
    document.getElementById('extraction-bottom-logs-status').textContent =
      'Logs will appear when the extraction worker starts.';
  }

  async function refreshExtractionLogs() {
    if (document.getElementById('extraction-bottom-bar').classList.contains('hidden') ||
        document.getElementById('extraction-bottom-diagnostics').classList.contains('hidden') ||
        !document.getElementById('extraction-bottom-logs').open || extractionLogFetching ||
        document.getElementById('extraction-bottom-log-download').classList.contains('hidden')) return;
    var generation = extractionLogGeneration;
    extractionLogFetching = true;
    var status = document.getElementById('extraction-bottom-logs-status');
    try {
      var response = await fetch('/api/project-extraction-log?format=json', { cache: 'no-store' });
      if ((response.headers.get('content-type') || '').toLowerCase().indexOf('application/json') === -1) {
        throw new Error('Live logs require the updated server. Restart serve.ps1.');
      }
      var payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not read live logs (HTTP ' + response.status + ').');
      if (!Array.isArray(payload.logs) || payload.tailLines !== 120 ||
          payload.logs.some(function(log) {
            return !log || typeof log.name !== 'string' || typeof log.label !== 'string' ||
              typeof log.content !== 'string' || typeof log.updatedAt !== 'string';
          })) {
        throw new Error('The server returned an invalid live log response.');
      }
      if (generation !== extractionLogGeneration) return;
      var container = document.getElementById('extraction-bottom-log-sections');
      payload.logs.forEach(function(log, index) {
        var section = extractionLogSections.get(log.name);
        if (!section) {
          var details = document.createElement('details');
          var summary = document.createElement('summary');
          var text = document.createElement('pre');
          details.append(summary, text);
          details.open = log.name === 'extraction.log';
          section = { details: details, summary: summary, text: text };
          extractionLogSections.set(log.name, section);
        }
        section.summary.textContent = log.label + ' - updated ' + new Date(log.updatedAt).toLocaleTimeString();
        var atBottom = section.text.scrollHeight - section.text.scrollTop - section.text.clientHeight < 24;
        if (section.text.textContent !== log.content) {
          section.text.textContent = log.content || 'No output yet.';
          if (atBottom) section.text.scrollTop = section.text.scrollHeight;
        }
        if (container.children[index] !== section.details) {
          container.insertBefore(section.details, container.children[index] || null);
        }
      });
      status.textContent = 'Latest 120 lines per log. ' +
        (payload.state === 'queued' || payload.state === 'running'
          ? 'Refreshes while expanded; Unity may be resolving packages, importing assets or compiling before export starts.'
          : 'Extraction has ended.') +
        ' Download Log includes the full output.';
    } catch (error) {
      if (generation !== extractionLogGeneration) return;
      status.textContent = 'Could not refresh live logs: ' + error.message;
      console.error('[effects-extractor] Could not refresh live logs:', error);
    } finally {
      if (generation === extractionLogGeneration) extractionLogFetching = false;
    }
  }

  async function showExtractionErrorLog(message) {
    var details = document.getElementById('extraction-bottom-errors');
    var text = document.getElementById('extraction-bottom-error-text');
    text.textContent = message || 'Extraction failed.';
    details.classList.remove('hidden');
    details.open = true;
    if (document.getElementById('extraction-bottom-log-download').classList.contains('hidden')) return;
    try {
      var response = await fetch('/api/project-extraction-log', { cache: 'no-store' });
      if (!response.ok) {
        var payload = await response.json();
        throw new Error(payload.error || 'Could not load the extraction log (HTTP ' + response.status + ').');
      }
      if ((response.headers.get('content-type') || '').toLowerCase().indexOf('text/plain') === -1) {
        throw new Error('The server did not return a text log. Restart the server with the updated serve.ps1.');
      }
      text.textContent = message + '\n\n' + await response.text();
    } catch (error) {
      text.textContent += '\n\nCould not load the diagnostic log: ' + error.message;
      console.error('[effects-extractor] Could not load extraction diagnostics:', error);
    }
  }

  function updateExtractionBar(pct, status, detail, countsHtml) {
    document.getElementById('extraction-bottom-fill').style.width = (pct || 0) + '%';
    document.getElementById('extraction-bottom-status').textContent = status || '';
    document.getElementById('extraction-bottom-detail').textContent = detail || '';
    document.getElementById('extraction-bottom-logs-summary').textContent = 'Steps & logs - ' + (detail || status || '');
    if (countsHtml !== undefined) {
      document.getElementById('extraction-bottom-counts').innerHTML = countsHtml;
    }
  }

  function finishExtractionBar(success, msg) {
    var icon = document.getElementById('extraction-bottom-icon');
    icon.textContent = success ? '✓' : '✕';
    icon.className = 'extraction-bottom-icon ' + (success ? 'done' : 'failed');
    document.getElementById('extraction-bottom-fill').style.width = '100%';
    document.getElementById('extraction-bottom-status').textContent = success ? 'Extraction complete' : 'Extraction failed';
    document.getElementById('extraction-bottom-detail').textContent = msg || '';
    document.getElementById('extraction-bottom-reload').classList.toggle('hidden', !success);
    document.getElementById('extraction-bottom-logs-summary').textContent =
      success ? 'Steps & logs - Extraction complete' : 'Steps & logs - Extraction failed';
  }

  document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('extraction-bottom-expand').addEventListener('click', function() {
      setExtractionLogsExpanded(this.getAttribute('aria-expanded') !== 'true');
    });
    document.getElementById('extraction-bottom-logs').addEventListener('toggle', function() {
      if (this.open) refreshExtractionLogs();
    });
    var reloadBtn = document.getElementById('extraction-bottom-reload');
    var closeBtn  = document.getElementById('extraction-bottom-close');
    if (reloadBtn) {
      reloadBtn.addEventListener('click', function() {
        document.getElementById('extraction-bottom-bar').classList.add('hidden');
        if (typeof loadGallery === 'function') loadGallery();
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', function() {
        document.getElementById('extraction-bottom-bar').classList.add('hidden');
      });
    }
  });

  function escText(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
})();
