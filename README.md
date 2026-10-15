# ViewFX for Unity

Editor-only companion package. Targets Unity 6000.3.15f1. FindFX extraction and previews require Windows.

## Install from Git

In Unity's Package Manager, choose **Install package from Git URL** (or **Add package from git URL** on older editors) and paste:

```text
https://github.com/awittig-igt/viewfx-unity.git
```

## Install locally

In Unity's Package Manager, choose **Install package from disk** (or **Add package from disk** on older editors) and select this folder's `package.json`. VFXStudio opens on first installation. Reopen it through **Window > VFXStudio**.

## Connect

The companion opens to a main menu with **ViewFX** and **FindFX** cards. Choose **Open ViewFX** to manage your connection and downloads, or **Open FindFX** to extract particles, VFX Graph effects and shaders and browse their previews in a local browser gallery. Use **Main Menu** in either tool to return to the cards.

Start the ViewFX API and website. Set **ViewFX site** to `http://localhost:5173` for local development, or the deployed HTTPS origin. Click **Connect to ViewFX**, sign in on the website, and choose **Allow** or **Deny**. Requests expire after ten minutes. **Cancel** invalidates a pending request. **Disconnect** revokes the connection on the server before clearing the local credential; when offline, retry disconnect once the server is reachable.

Connections are independent per project path and operating-system user. On Windows, credentials are encrypted with Windows DPAPI and saved under the user's local application data, outside the Unity project. On macOS/Linux this first version uses Unity SessionState, so reconnect after closing Unity. Credentials expire after 90 days. **Check Connection** verifies the current credential.

## Download effects

Connected, open projects register automatically even when the ViewFX window is closed. On the website, click **Add to Unity**, select this project, and click **Proceed**. The site shows download progress and can cancel the download. After completion, Unity opens its standard package import dialog for review. Imports wait while Unity is compiling, updating assets, or in Play mode. Downloads are saved to the operating system's temporary ViewFX directory; cancelled files are removed.


## FindFX: extract and preview

Open **Window > VFXStudio > Open FindFX**. Choose your local library folder and click **Extract and Preview**. The adjacent **Open FindFX webapp** button opens the existing library in your browser, starting or reusing its local server without extracting effects or launching a preview Editor. Advanced settings provide **Scan particles**, **Scan VFX Graph effects**, and **Scan shaders** checkboxes, all enabled by default and saved between Editor sessions. Enable **Include selected assets/folders** to include prefabs, `.vfx`, `.shader`, `.shadergraph` assets or folders under Assets. At least one scan type must be enabled. The active scene is scanned, including inactive objects and unsaved prefab instance overrides; other open scenes are excluded. Selected folders are searched recursively. The shader scan finds shaders used by scene/selected-prefab materials and VFX Graph dependencies, plus selected shader assets. Shader include files and subgraphs are bundled as dependencies rather than separate previews. Advanced settings expose the web server port (default 8080).

Source objects and assets are preserved. Extracted hierarchies become disconnected effect prefabs with scripts and unrelated components removed. Particle packages retain Particle Systems, VFX packages retain Visual Effect components and their graph assets, and shader packages include the shader with a sphere and preview material. Dependencies on non-standard packages (package names outside `com.unity.*`) are skipped with Console warnings. Generated assets under `Assets/EffectsExtractor/ParticlePackages` are temporary; do not store your own assets there.

The bundled PowerShell server opens a separate local browser gallery. Unity 6000.3.15f1 imports packages and captures previews in a disposable copy of the bundled URP template with VFX Graph support. Shader spheres and simulated VFX Graph effects use Unity-rendered image previews in the gallery. Each category provides a downloadable `.unitypackage` with its asset dependencies. Install that Editor through Unity Hub. The source Editor stays open; no Node.js installation or EffectsExtractor checkout is needed. Renderer compatibility matters: built-in or HDRP effects may need a different preview template. ViewFX account connection is not required for local extraction.

## Publish extracted effects

Click **Upload to ViewFX** in the gallery's side preview or on an effect's detail page. A generated Unity package and preview image are required; the button explains missing requirements when disabled. Enter your ViewFX website URL (HTTPS, or HTTP localhost for development), then **Connect to ViewFX**. Sign in and approve publishing in the opened ViewFX page. If the popup is blocked, use the approval link in the dialog. Publishing access is separate from the Unity download connection.

Review the name, description and comma-separated tags, and choose the rendering pipeline. The Unity release version fills automatically from the effect's extraction metadata. Older local effects can use the configured source project's version when their project identity matches. The version remains editable; supply it manually when unavailable. Click **Upload effect**. Progress covers the transfer and server-side package validation; the result links directly to the published effect. Retrying the same library effect under the same account returns the existing effect instead of creating another. Edit already published effects on the ViewFX website.

The website URL is remembered locally. The publishing credential stays in this browser tab's session storage; reconnect after closing the tab. Server credentials expire after 90 days, and **Disconnect** revokes the credential immediately. GitHub package storage credentials remain on the ViewFX server. Restart the FindFX web server after updating the companion so the updated detail page is served.

Run `node --test Tests~/ViewFXPublisher.tests.cjs` for the publishing browser-controller tests. They cover required assets, connection approval, upload payloads, stable retry IDs, server errors, and disconnect without accessing a live account or package repository.

The library persists at the chosen folder (default `%LOCALAPPDATA%\FindFX\Library`). The server reuses a compatible existing instance or finds another free port. Only one preview job runs per server. Switching tools or closing VFXStudio does not stop the launcher or preview job. The gallery shows progress and errors; the Unity panel provides the launch log path. Use **Kill all servers** in the FindFX card to stop all FindFX PowerShell web servers across projects. The card reports the result. This interrupts web requests; saved library files are preserved. The button verifies each disposable runtime path and its `server.pid` before stopping the process. Unrelated PowerShell processes and Unity Editors are left running.

Runtime logs live under `%TEMP%\FindFX_<run-id>` and `%TEMP%\EffectsExtractorProjectJob_<job-id>`. Disposable preview projects use `%TEMP%\FXP_<id>` and are cleaned up by the worker. If Windows temporarily blocks a Package Manager cache rename (`EPERM`), the import retries the same preview project up to three times after 2, 4, and 8 seconds, preserving completed package installations. Earlier attempt logs are retained beside the main import log. Other import errors fail immediately.

## Build and validate

The checked-in `Tools~` runtime supports both Git and local package installation. Build a standalone release with `powershell.exe -NoProfile -File .\build-package.ps1`; install `outputs\com.viewfx.editor-0.3.0.tgz` through Package Manager's **Install package from tarball**.

Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Tests~\findfx.tests.ps1` to verify package compilation, scene scope, prefab overrides, source preservation, scan-type filtering, and seven published particle/VFX/shader packages with visible PNG previews. The test uses Unity 6000.3.15f1 and a disposable source project held locked during preview generation.

Run `powershell.exe -NoProfile -File .\Tests~\PackageCacheRecovery.tests.ps1` to verify package-cache retry recovery and error handling without launching Unity.

Run `powershell.exe -NoProfile -File .\Tests~\OpenWebapp.tests.ps1` to verify that opening the gallery starts or reuses its server without launching extraction.

The FindFX runtime was incorporated from EffectsExtractor. When changing the exporter, also update `Tools~/extractor/unity-tools/ParticlePackageExporterV2.cs`, which is injected into disposable automation projects. Keep runtime scripts, gallery files, capture scripts, and template settings together when updating that workflow.

EffectsExtractor components retain their MIT license in Tools~/EffectsExtractor-LICENSE.txt.
