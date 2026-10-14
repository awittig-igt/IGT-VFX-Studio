/**
 * package-importer.js
 * Handles the "Upload Package" modal:
 *   1. User picks a .unitypackage → browser POSTs binary to /api/upload-package
 *   2. The open Unity Editor imports the package and builds EffectsCaptureScene
 *   3. Unity captures each particle prefab; the browser imports captures automatically
 *   4. Gallery reloads with real Unity screenshots
 */
;(function initPackageImporter() {

  // ── Element helpers ────────────────────────────────────────────────────
  const modal = () => document.getElementById('modal-upload-package');
  const el    = id  => document.getElementById(id);
  const STEPS = ['pick', 'uploading', 'done'];

  function showStep(name) {
    STEPS.forEach(s => el('pkg-step-' + s)?.classList.add('hidden'));
    el('pkg-step-' + name)?.classList.remove('hidden');
    el('pkg-step-label').textContent =
      name === 'pick' || name === 'uploading' ? 'Step 1 of 2' :
      name === 'done' ? 'Step 2 of 2' : '';
  }

  // ── Open / close ───────────────────────────────────────────────────────
  async function openModal() {
    showStep('pick');
    el('pkg-file-input').value = '';
    el('btn-upload-pkg').disabled = true;
    el('pkg-import-msg').textContent = '';
    el('pkg-captures-count').textContent = '';
    modal().classList.remove('hidden');
    await refreshUnityPath();
  }
  function closeModal() { modal().classList.add('hidden'); }

  async function refreshUnityPath() {
    try {
      const r = await fetch('/api/config');
      if (r.ok) {
        const d = await r.json();
        const p = d.unityProjectPath || '';
        el('pkg-unity-path').textContent = p || '(not set — configure in Settings)';
        el('pkg-no-path-warn').classList.toggle('hidden', Boolean(p));
        updateUploadBtn();
      }
    } catch {
      el('pkg-unity-path').textContent = '(server not responding)';
    }
  }

  function updateUploadBtn() {
    const hasFile = el('pkg-file-input').files.length > 0;
    const hasPath = !el('pkg-no-path-warn').classList.contains('hidden') === false;
    // Enable if we have a file (path warning is advisory, not blocking)
    el('btn-upload-pkg').disabled = !hasFile;
  }

  // ── Boot ───────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btn-upload-package').addEventListener('click', openModal);
    el('btn-close-upload-pkg').addEventListener('click', closeModal);
    el('btn-cancel-upload').addEventListener('click', closeModal);
    el('btn-close-pkg-done').addEventListener('click', closeModal);
    modal().addEventListener('click', e => { if (e.target === modal()) closeModal(); });

    el('btn-pkg-open-settings').addEventListener('click', () => {
      closeModal();
      document.getElementById('btn-settings').click();
    });

    el('pkg-file-input').addEventListener('change', updateUploadBtn);

    // ── Upload ─────────────────────────────────────────────────────────
    el('btn-upload-pkg').addEventListener('click', async () => {
      const file = el('pkg-file-input').files[0];
      if (!file) return;

      showStep('uploading');
      el('pkg-upload-status').textContent = 'Uploading ' + file.name + '…';
      el('pkg-progress-bar').style.width  = '0%';
      el('pkg-upload-pct').textContent    = '';

      try {
        const result = await uploadPackage(file, pct => {
          el('pkg-progress-bar').style.width = Math.round(pct * 100) + '%';
          el('pkg-upload-pct').textContent   = Math.round(pct * 100) + '%  —  ' +
            (pct < 1 ? (file.size * pct / 1024 / 1024).toFixed(1) + ' MB sent' : 'complete');
        });

        el('pkg-saved-path').textContent = result.sizeMb + ' MB saved to: ' + result.path;
        showStep('done');
        if (result.jobStarted) {
          pollPackageJob();
        } else {
          el('pkg-captures-count').textContent = result.warning || 'Unity automation could not be started.';
          checkCaptures();
        }
      } catch (err) {
        el('pkg-upload-status').textContent = '✕ ' + err.message;
      }
    });

    // ── Check captures ─────────────────────────────────────────────────
    el('btn-check-captures').addEventListener('click', checkCaptures);

    async function checkCaptures() {
      el('pkg-captures-count').textContent = 'Checking captures folder…';
      try {
        const r = await fetch('/api/captures');
        const d = await r.json();
        if (d.ok && d.count > 0) {
          el('pkg-captures-count').textContent =
            '✓ ' + d.count + ' PNG' + (d.count !== 1 ? 's' : '') + ' found in: ' + d.folder;
          el('btn-import-captures').disabled = false;
        } else {
          el('pkg-captures-count').textContent =
            '⏳ No captures yet in: ' + d.folder +
            '\n  Open Unity → Effects Extractor → Capture Thumbnails';
          el('btn-import-captures').disabled = true;
        }
      } catch (err) {
        el('pkg-captures-count').textContent = 'Error: ' + err.message;
      }
    }

    async function pollPackageJob() {
      const importTask = el('pkg-task-import');
      const captureTask = el('pkg-task-capture');
      const galleryTask = el('pkg-task-gallery');
      [importTask, captureTask, galleryTask].forEach(task => task?.classList.remove('pkg-step-done', 'pkg-step-error'));
      el('btn-check-captures').disabled = true;
      el('btn-import-captures').disabled = true;

      const deadline = Date.now() + 15 * 60 * 1000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch('/api/package-job', { cache: 'no-store' });
          const job = await response.json();
          el('pkg-captures-count').textContent = job.message || 'Unity is working...';

          if (job.phase === 'import') {
            el('pkg-progress-bar').style.width = Math.max(20, job.progress || 20) + '%';
          }
          if (job.phase === 'capture') {
            importTask?.classList.add('pkg-step-done');
            el('pkg-progress-bar').style.width = Math.max(65, job.progress || 65) + '%';
          }
          if (job.state === 'failed') {
            const task = job.phase === 'import' ? importTask : captureTask;
            task?.classList.add('pkg-step-error');
            el('pkg-import-msg').textContent = 'Unity job failed: ' + (job.message || 'Unknown error');
            el('btn-check-captures').disabled = false;
            return;
          }
          if (job.state === 'complete') {
            importTask?.classList.add('pkg-step-done');
            captureTask?.classList.add('pkg-step-done');
            el('pkg-progress-bar').style.width = '90%';
            el('btn-import-captures').disabled = false;
            el('btn-import-captures').click();
            return;
          }
        } catch (err) {
          el('pkg-captures-count').textContent = 'Waiting for the server: ' + err.message;
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
      }

      el('pkg-import-msg').textContent = 'Unity did not finish within 15 minutes. Check the Unity job logs and retry.';
      el('btn-check-captures').disabled = false;
    }

    // ── Import captures ────────────────────────────────────────────────
    el('btn-import-captures').addEventListener('click', async () => {
      el('btn-import-captures').disabled = true;
      el('pkg-import-msg').textContent   = 'Importing…';

      try {
        const r = await fetch('/api/import-captures', { method: 'POST' });
        const d = await r.json();
        if (d.ok) {
          el('pkg-task-gallery')?.classList.add('pkg-step-done');
          el('pkg-progress-bar').style.width = '100%';
          el('pkg-import-msg').textContent =
            '✓ ' + d.imported + ' thumbnail(s) imported' +
            (d.skipped ? ' (' + d.skipped + ' skipped — no matching effect)' : '') +
            '. Reloading gallery…';
          setTimeout(() => {
            closeModal();
            if (typeof loadGallery === 'function') loadGallery();
          }, 1800);
        } else {
          el('pkg-import-msg').textContent = '✕ ' + (d.error || 'Unknown error');
          el('btn-import-captures').disabled = false;
        }
      } catch (err) {
        el('pkg-import-msg').textContent = '✕ ' + err.message;
        el('btn-import-captures').disabled = false;
      }
    });
  });

  // ── Upload helper (XHR with progress) ────────────────────────────────
  function uploadPackage(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload-package');
      xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');

      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.upload.onload = () => onProgress(1);

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { reject(new Error('Invalid server response')); }
        } else {
          let msg = 'Upload failed (' + xhr.status + ')';
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.send(file);
    });
  }

})();
