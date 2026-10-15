/* global getEffectDownloadItems, getConfig */
(() => {
  const dialog = document.getElementById('publish-viewfx-dialog');
  const form = document.getElementById('publish-viewfx-form');
  const button = document.getElementById('btn-publish-viewfx');
  const submit = document.getElementById('publish-submit');
  const connect = document.getElementById('publish-connect');
  const disconnect = document.getElementById('publish-disconnect');
  const status = document.getElementById('publish-status');
  const account = document.getElementById('publish-account');
  const resultLink = document.getElementById('publish-result');
  const field = name => form.elements.namedItem(name);
  let effect, source, credential, pending, busy = false;

  function validateTags() {
    const input = field('tags');
    const tags = input.value.trim() ? input.value.split(',').map(tag => tag.trim()) : [];
    const invalid = /[\u0000-\u001f\u007f]/.test(input.value) || tags.some(tag => !tag || tag.length > 100);
    input.setCustomValidity(invalid ? 'Separate tags with commas. Each tag must be 1–100 characters, with no empty entries or control characters.' : '');
    return invalid ? null : tags;
  }
  field('tags').addEventListener('input', validateTags);

  async function fillUnityVersion(selectedEffect, selectedSource) {
    // Older local libraries predate per-effect versions. Only use the configured
    // source project when its identity matches; the preview project's version is unrelated.
    if (field('unityVersion').value || selectedSource !== 'local') return;
    try {
      const response = await fetch('/api/config', { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const config = await response.json();
      const normalize = path => String(path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const project = normalize(config.sourceProjectPath);
      const matches = selectedEffect.sourceProjectPath
        ? normalize(selectedEffect.sourceProjectPath) === project
        : selectedEffect.importSource === 'project-scan' && normalize(selectedEffect.game) === project.split('/').pop();
      const version = config.sourceProjectValidation?.editorVersion;
      if (project && matches && /^\d+\.\d+\.\d+f\d+$/.test(version || '') && effect === selectedEffect && !field('unityVersion').value) {
        field('unityVersion').value = version;
      }
    } catch { /* Keep the version editable when the source project is unavailable. */ }
  }

  function siteOrigin() {
    const url = new URL(field('site').value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
      throw new Error('Use an HTTPS ViewFX URL, or HTTP on localhost for development.');
    }
    return url.origin;
  }

  async function api(site, path, options = {}) {
    const response = await fetch(site + '/api/publisher' + path, { ...options, credentials: 'omit', signal: AbortSignal.timeout(20000) });
    const body = await response.json().catch(() => ({ error: 'ViewFX returned an invalid response.' }));
    if (!response.ok) throw new Error(body.error || `ViewFX returned HTTP ${response.status}.`);
    return body;
  }

  function refresh() {
    const connected = credential && credential.site === field('site').value;
    account.textContent = connected ? `Connected as ${credential.user.name}` : 'Connect your ViewFX account to publish.';
    disconnect.hidden = !connected;
    connect.disabled = busy || Boolean(pending) || Boolean(connected);
    field('site').disabled = busy || Boolean(pending);
    submit.disabled = busy || !connected;
  }

  document.addEventListener('effect-ready', event => {
    ({ effect, source } = event.detail);
    const items = getEffectDownloadItems(effect, source);
    const supported = ['particle', 'shader', 'vfx'].includes(effect.type);
    button.disabled = !supported || !items.some(item => item.kind === 'package') || !effect.files?.thumbnail;
    button.title = button.disabled ? 'Publishing requires a supported effect, Unity package, and generated preview image.' : 'Publish this effect to your ViewFX account';
  });

  button.addEventListener('click', async () => {
    field('site').value = localStorage.getItem('viewfx-publish-site') || 'http://localhost:5173';
    field('name').value = effect.name || '';
    field('description').value = effect.description || '';
    field('tags').value = effect.game || '';
    validateTags();
    field('unityVersion').value = effect.unityVersion || effect.metadata?.unityVersion || '';
    field('renderingPipeline').value = effect.renderingPipeline || effect.metadata?.renderingPipeline || '';
    status.textContent = '';
    resultLink.hidden = true;
    try { credential = JSON.parse(sessionStorage.getItem('viewfx-publisher') || 'null'); } catch { credential = null; }
    refresh();
    dialog.showModal();
    await fillUnityVersion(effect, source);
    if (credential?.site === field('site').value) {
      try { await api(credential.site, '/connection', { headers: { Authorization: `Bearer ${credential.token}` } }); }
      catch (error) { credential = null; sessionStorage.removeItem('viewfx-publisher'); status.textContent = error.message; }
      refresh();
    }
  });

  field('site').addEventListener('input', refresh);
  connect.addEventListener('click', async () => {
    // Open immediately during the click so browser popup protection permits approval.
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    status.textContent = '';
    busy = true; refresh();
    document.getElementById('publish-close').disabled = true;
    let attempt;
    try {
      const site = siteOrigin();
      field('site').value = site;
      localStorage.setItem('viewfx-publish-site', site);
      const request = await api(site, '/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectName: effect.game || 'FindFX Library', unityVersion: field('unityVersion').value }) });
      attempt = { site, ...request }; pending = attempt;
      document.getElementById('publish-close').disabled = false;
      const approval = new URL(request.approvalUrl);
      if (approval.origin !== site || approval.pathname !== '/publisher/connect') throw new Error('ViewFX returned an invalid approval URL.');
      resultLink.href = approval.href; resultLink.textContent = 'Approve connection in ViewFX'; resultLink.hidden = false;
      if (popup) popup.location.href = approval.href;
      status.textContent = 'Sign in and allow publishing in ViewFX. Waiting for approval…';
      while (pending === attempt && Date.now() < new Date(request.expiresAt).getTime()) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        if (pending !== attempt) break;
        const result = await api(site, `/requests/${request.id}/poll`, { method: 'POST', headers: { Authorization: `Bearer ${request.pollToken}` } });
        if (pending !== attempt) break;
        if (result.status === 'connected') {
          credential = { site, token: result.token, user: result.user };
          sessionStorage.setItem('viewfx-publisher', JSON.stringify(credential));
          status.textContent = 'Connected. Review the effect details, then upload.';
          resultLink.hidden = true;
          return;
        }
        if (result.status !== 'pending') throw new Error(`Connection ${result.status}. Start a new connection to try again.`);
      }
      if (pending === attempt) throw new Error('Connection request expired. Connect again.');
    } catch (error) {
      status.textContent = error.message;
      if (attempt) api(attempt.site, `/requests/${attempt.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${attempt.pollToken}` } }).catch(() => {});
    }
    finally {
      if (pending === attempt) pending = null;
      document.getElementById('publish-close').disabled = false;
      busy = false; refresh();
    }
  });

  disconnect.addEventListener('click', async () => {
    busy = true; refresh();
    try {
      await api(credential.site, '/connection', { method: 'DELETE', headers: { Authorization: `Bearer ${credential.token}` } });
      credential = null; sessionStorage.removeItem('viewfx-publisher'); status.textContent = 'Disconnected.';
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; refresh(); }
  });

  async function asset(item) {
    const url = new URL(item.url, location.href);
    const headers = {};
    if (['github.com', 'raw.githubusercontent.com', 'api.github.com'].includes(url.hostname) && getConfig().token) {
      headers.Authorization = `Bearer ${getConfig().token}`;
    }
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Could not read ${item.filename}: HTTP ${response.status}.`);
    return response.blob();
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const tags = validateTags();
    if (!tags) { field('tags').reportValidity(); return; }
    if (busy || !credential || credential.site !== siteOrigin()) return;
    busy = true; refresh(); resultLink.hidden = true;
    document.getElementById('publish-close').disabled = true;
    try {
      const items = getEffectDownloadItems(effect, source);
      status.textContent = 'Reading package and preview…';
      const packageItem = items.find(item => item.kind === 'package');
      const previewItem = items.find(item => item.kind === 'preview');
      if (!packageItem || !previewItem) throw new Error('Generate a Unity package and preview before publishing.');
      const [pkg, preview] = await Promise.all([asset(packageItem), asset(previewItem)]);
      if (pkg.size > 70 * 1024 * 1024) throw new Error('The Unity package exceeds 70 MiB.');
      if (preview.size > 100 * 1024 * 1024) throw new Error('The preview exceeds 100 MiB.');
      const data = new FormData();
      ['name', 'description', 'unityVersion', 'renderingPipeline'].forEach(name => data.append(name, field(name).value));
      data.append('type', effect.type);
      data.append('tags', JSON.stringify(tags));
      data.append('package', pkg, packageItem.filename);
      data.append('media', preview, previewItem.filename);
      const identity = JSON.stringify([source === 'local' ? 'local' : getConfig().repo, effect.game || '', effect.id]);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
      const sourceId = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', credential.site + '/api/publisher/cards');
        xhr.setRequestHeader('Authorization', `Bearer ${credential.token}`);
        xhr.setRequestHeader('X-Source-Id', sourceId);
        xhr.timeout = 15 * 60 * 1000;
        xhr.upload.onprogress = event => { if (event.lengthComputable) status.textContent = `Uploading… ${Math.round(event.loaded / event.total * 100)}%`; };
        xhr.upload.onload = () => { status.textContent = 'Upload received. ViewFX is validating and publishing the Unity package…'; };
        xhr.onload = () => {
          let result;
          try { result = JSON.parse(xhr.responseText); } catch { reject(new Error('Invalid ViewFX response. You can safely retry.')); return; }
          if (xhr.status >= 200 && xhr.status < 300) resolve(result);
          else reject(new Error(result.error || `Upload failed: HTTP ${xhr.status}.`));
        };
        xhr.onerror = () => reject(new Error('Could not contact ViewFX. Check the website URL and connection. You can safely retry.'));
        xhr.ontimeout = () => reject(new Error('Publishing timed out. You can safely retry without creating another effect.'));
        xhr.send(data);
      });
      status.textContent = result.alreadyPublished ? `This effect is already published in ViewFX (effect ${result.id}).` : `Published to ViewFX (effect ${result.id}).`;
      resultLink.href = credential.site + '/?effect=' + encodeURIComponent(result.id); resultLink.textContent = 'View published effect'; resultLink.hidden = false;
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; document.getElementById('publish-close').disabled = false; refresh(); }
  });

  dialog.addEventListener('cancel', event => { if (busy && !pending) event.preventDefault(); });
  document.getElementById('publish-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    const request = pending; pending = null;
    if (request) api(request.site, `/requests/${request.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${request.pollToken}` } }).catch(() => {});
  });
})();
