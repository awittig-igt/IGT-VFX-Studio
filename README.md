# ViewFX for Unity

Editor-only companion package. Requires Unity 2022.3 or newer.

## Install from Git

In Unity's Package Manager, choose **Install package from Git URL** (or **Add package from git URL** on older editors) and paste:

```text
https://github.com/awittig-igt/viewfx-unity.git
```

## Install locally

In Unity's Package Manager, choose **Install package from disk** (or **Add package from disk** on older editors) and select this folder's `package.json`. VFXStudio opens on first installation. Reopen it through **Window > VFXStudio**.

## Connect

The companion opens to a main menu with **ViewFX** and **FindFX** cards. Choose **Open ViewFX** to manage your connection and downloads, or **Open FindFX** to visit the upcoming project discovery tools. Use **Main Menu** in either tool to return to the cards.

Start the ViewFX API and website. Set **ViewFX site** to `http://localhost:5173` for local development, or the deployed HTTPS origin. Click **Connect to ViewFX**, sign in on the website, and choose **Allow** or **Deny**. Requests expire after ten minutes. **Cancel** invalidates a pending request. **Disconnect** revokes the connection on the server before clearing the local credential; when offline, retry disconnect once the server is reachable.

Connections are independent per project path and operating-system user. On Windows, credentials are encrypted with Windows DPAPI and saved under the user's local application data, outside the Unity project. On macOS/Linux this first version uses Unity SessionState, so reconnect after closing Unity. Credentials expire after 90 days. **Check Connection** verifies the current credential.

## Download effects

Connected, open projects register automatically even when the ViewFX window is closed. On the website, click **Add to Unity**, select this project, and click **Proceed**. The site shows download progress and can cancel the download. After completion, Unity opens its standard package import dialog for review. Imports wait while Unity is compiling, updating assets, or in Play mode. Downloads are saved to the operating system's temporary ViewFX directory; cancelled files are removed. Upload effects through the ViewFX website.
