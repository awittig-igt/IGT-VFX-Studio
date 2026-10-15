using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using UnityEditor;
using PackageInfo = UnityEditor.PackageManager.PackageInfo;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace ViewFX.Editor
{
    [InitializeOnLoad]
    internal static class FindFXPanel
    {
        private static bool includeSelection;
        private static bool scanParticles = EditorPrefs.GetBool("FindFX.ScanParticles", true);
        private static bool scanVfx = EditorPrefs.GetBool("FindFX.ScanVfx", true);
        private static bool scanShaders = EditorPrefs.GetBool("FindFX.ScanShaders", true);
        private static bool advanced;
        private static int port = 8080;
        private static string libraryPath;
        private static Process launcher;
        private static string launchLog;
        private static Process serverStopper;
        private static string serverStopLog;
        private static string serverStopStatus;
        private const string LauncherKey = "ViewFX.FindFX.Launcher";
        public static bool IsLaunching => launcher != null;

        static FindFXPanel()
        {
            libraryPath = EditorPrefs.GetString("FindFX.LibraryPath",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "FindFX", "Library"));
            port = EditorPrefs.GetInt("FindFX.Port", 8080);
            launchLog = SessionState.GetString(LauncherKey + ".Log", "");
            int pid = SessionState.GetInt(LauncherKey, 0);
            if (pid > 0)
            {
                try { launcher = Process.GetProcessById(pid); }
                catch (ArgumentException) { SessionState.EraseInt(LauncherKey); }
            }
            EditorApplication.update += CheckLauncher;
            AssemblyReloadEvents.beforeAssemblyReload += DisposeLauncher;
            EditorApplication.quitting += DisposeLauncher;
        }

        private static void DisposeLauncher()
        {
            launcher?.Dispose();
            launcher = null;
            serverStopper?.Dispose();
            serverStopper = null;
        }

        public static void Draw()
        {
            EditorGUILayout.HelpBox(
                "Extract particles, VFX Graph effects and shaders from the active scene, including inactive objects and prefab " +
                "instance overrides. Other open scenes are not scanned.", MessageType.Info);
            libraryPath = EditorGUILayout.TextField("Local library folder", libraryPath);
            if (ViewFXWindow.CenteredButton("Browse library folder"))
            {
                try
                {
                    if (string.IsNullOrWhiteSpace(libraryPath) || !Path.IsPathRooted(libraryPath.Trim()))
                        throw new InvalidOperationException("Choose an absolute local library folder.");
                    var folder = Path.GetFullPath(libraryPath.Trim());
                    Directory.CreateDirectory(folder);
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = folder,
                        UseShellExecute = true
                    });
                }
                catch (Exception exception)
                {
                    EditorUtility.DisplayDialog("FindFX library folder", exception.Message, "OK");
                }
            }
            advanced = EditorGUILayout.Foldout(advanced, "Advanced settings", true);
            if (advanced)
            {
                port = EditorGUILayout.IntField("Web app port", port);
                EditorGUI.BeginChangeCheck();
                scanParticles = EditorGUILayout.ToggleLeft("Scan particles", scanParticles);
                scanVfx = EditorGUILayout.ToggleLeft("Scan VFX Graph effects", scanVfx);
                scanShaders = EditorGUILayout.ToggleLeft("Scan shaders", scanShaders);
                if (EditorGUI.EndChangeCheck())
                {
                    EditorPrefs.SetBool("FindFX.ScanParticles", scanParticles);
                    EditorPrefs.SetBool("FindFX.ScanVfx", scanVfx);
                    EditorPrefs.SetBool("FindFX.ScanShaders", scanShaders);
                }
                includeSelection = EditorGUILayout.ToggleLeft("Include selected assets/folders", includeSelection);
                if (includeSelection)
                    EditorGUILayout.HelpBox(
                        "Select prefabs, VFX Graph assets, shaders or folders under Assets in the Project window. " +
                        "Folders are searched recursively; unrelated assets are not scanned.", MessageType.Info);
                using (new EditorGUI.DisabledScope(Application.platform != RuntimePlatform.WindowsEditor ||
                    launcher != null || serverStopper != null))
                {
                    if (ViewFXWindow.CenteredButton("Kill all servers"))
                        StopAllServers();
                }
                if (!string.IsNullOrEmpty(serverStopStatus))
                    EditorGUILayout.HelpBox(serverStopStatus, MessageType.Info);
            }
            EditorGUILayout.HelpBox(
                "Windows only. Requires Unity 6000.3.15f1. Previews use a disposable copy; the source stays open.",
                MessageType.None);
            using (new EditorGUI.DisabledScope(EditorApplication.isPlayingOrWillChangePlaymode ||
                EditorApplication.isCompiling || EditorApplication.isUpdating || launcher != null || serverStopper != null || Application.platform != RuntimePlatform.WindowsEditor))
            {
                using (new EditorGUILayout.HorizontalScope())
                {
                    GUILayout.FlexibleSpace();
                    if (GUILayout.Button("Extract and Preview", GUILayout.Width(150), GUILayout.Height(36)))
                        Run();
                    if (GUILayout.Button("Open FindFX webapp", GUILayout.Width(150), GUILayout.Height(36)))
                        Run(false);
                    GUILayout.FlexibleSpace();
                }
            }
            if (launcher != null)
                EditorGUILayout.HelpBox("Opening the local FindFX webapp...", MessageType.Info);
            if (!string.IsNullOrEmpty(launchLog))
                EditorGUILayout.SelectableLabel("Launch log: " + launchLog, EditorStyles.textField,
                    GUILayout.Height(38));
        }

        private static void Run(bool extract = true)
        {
            try
            {
                if (Application.platform != RuntimePlatform.WindowsEditor)
                    throw new PlatformNotSupportedException("FindFX's local server currently requires Windows.");
                if (port < 1024 || port > 65535)
                    throw new InvalidOperationException("Use a web app port between 1024 and 65535.");
                if (string.IsNullOrWhiteSpace(libraryPath) || !Path.IsPathRooted(libraryPath))
                    throw new InvalidOperationException("Choose an absolute local library folder.");
                var selection = extract && includeSelection
                    ? Selection.objects.Select(AssetDatabase.GetAssetPath).Distinct().ToArray()
                    : Array.Empty<string>();
                if (extract && includeSelection && (selection.Length == 0 || selection.Any(string.IsNullOrEmpty)))
                    throw new InvalidOperationException("Select effect assets or folders in the Project window.");
                if (extract && !scanParticles && !scanVfx && !scanShaders)
                    throw new InvalidOperationException("Enable at least one scan type in Advanced settings.");
                var package = PackageInfo.FindForAssembly(typeof(FindFXPanel).Assembly);
                if (package == null)
                    throw new InvalidOperationException("Install the ViewFX companion through Unity Package Manager.");
                var runtime = Path.Combine(package.resolvedPath, "Tools~");
                var startScript = Path.Combine(runtime, "start-findfx.ps1");
                if (!File.Exists(startScript))
                    throw new InvalidOperationException(
                        "The standalone runtime is missing. Reinstall the complete ViewFX companion package.");
                var project = Directory.GetParent(Application.dataPath).FullName;
                var runFolder = Path.Combine(Path.GetTempPath(), "FindFX_" + Guid.NewGuid().ToString("N"));
                var exports = Path.Combine(runFolder, "packages");
                Directory.CreateDirectory(runFolder);
                if (extract)
                    EffectsExtractor.Editor.ParticlePackageExporterV2.ExportActiveScene(
                        exports, selection, scanParticles, scanVfx, scanShaders);
                EditorPrefs.SetString("FindFX.LibraryPath", libraryPath);
                EditorPrefs.SetInt("FindFX.Port", port);
                launchLog = Path.Combine(runFolder, "launch.log");
                var command = "& { try { & " + QuotePowerShell(startScript) +
                    " -RuntimePath " + QuotePowerShell(runtime) +
                    " -SourceProjectPath " + QuotePowerShell(project) +
                    " -RunPath " + QuotePowerShell(runFolder) +
                    (extract ? " -PreExportedPath " + QuotePowerShell(exports) : " -OpenOnly") +
                    " -LocalFolder " + QuotePowerShell(Path.GetFullPath(libraryPath)) +
                    " -Port " + port +
                    " } catch { [Console]::Error.WriteLine($_); Write-Output ('FindFX launch failed: ' + $_); exit 1 } } *> " +
                    QuotePowerShell(launchLog);
                var encoded = Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes(command));
                launcher = Process.Start(new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -EncodedCommand " + encoded,
                    UseShellExecute = false,
                    CreateNoWindow = true
                });
                if (launcher == null)
                    throw new InvalidOperationException("Could not start the FindFX launcher.");
                SessionState.SetInt(LauncherKey, launcher.Id);
                SessionState.SetString(LauncherKey + ".Log", launchLog);

            }
            catch (Exception exception)
            {
                Debug.LogException(exception);
                EditorUtility.DisplayDialog("FindFX failed", exception.Message, "OK");
            }
        }

        private static string QuotePowerShell(string value)
        {
            return "'" + value.Replace("'", "''") + "'";
        }

        private static void StopAllServers()
        {
            try
            {
                var package = PackageInfo.FindForAssembly(typeof(FindFXPanel).Assembly);
                if (package == null)
                    throw new InvalidOperationException("Could not locate the ViewFX companion package.");
                var script = Path.Combine(package.resolvedPath, "Tools~", "stop-findfx-servers.ps1");
                if (!File.Exists(script))
                    throw new FileNotFoundException("The FindFX server stop script is missing.", script);
                serverStopLog = Path.Combine(Path.GetTempPath(), "FindFX_Stop_" + Guid.NewGuid().ToString("N") + ".log");
                var command = "& { try { & " + QuotePowerShell(script) +
                    " } catch { Write-Output $_; exit 1 } } *> " + QuotePowerShell(serverStopLog);
                serverStopper = Process.Start(new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -EncodedCommand " +
                        Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes(command)),
                    UseShellExecute = false,
                    CreateNoWindow = true
                });
                if (serverStopper == null)
                    throw new InvalidOperationException("Could not start the FindFX server cleanup.");
                serverStopStatus = "Stopping all FindFX web servers...";
            }
            catch (Exception exception)
            {
                serverStopStatus = "Could not stop FindFX servers: " + exception.Message;
                Debug.LogException(exception);
            }
        }

        private static void CheckLauncher()
        {
            if (serverStopper != null && serverStopper.HasExited)
            {
                var code = serverStopper.ExitCode;
                serverStopper.Dispose();
                serverStopper = null;
                var result = File.Exists(serverStopLog) ? File.ReadAllText(serverStopLog).Trim() : "No cleanup log was produced.";
                serverStopStatus = code == 0 ? result : "FindFX server cleanup failed: " + result;
                if (code == 0) Debug.Log("[FindFX] " + serverStopStatus);
                else Debug.LogError("[FindFX] " + serverStopStatus);
            }
            if (launcher == null || !launcher.HasExited)
                return;
            var exitCode = launcher.ExitCode;
            launcher.Dispose();
            launcher = null;
            SessionState.EraseInt(LauncherKey);

            if (exitCode != 0)
            {
                var detail = File.Exists(launchLog) ? File.ReadAllText(launchLog).Trim() : string.Empty;
                if (string.IsNullOrEmpty(detail))
                    detail = "Launcher exited with code " + exitCode + ". No launch log was produced.";
                Debug.LogError("[FindFX] Local web app launch failed:\n" + detail);
                EditorUtility.DisplayDialog("FindFX launch failed", detail, "OK");
            }
            else
            {
                var info = File.Exists(launchLog) ? File.ReadAllText(launchLog).Trim() : string.Empty;
                if (!string.IsNullOrEmpty(info))
                    Debug.Log("[FindFX] " + info);
            }

        }

    }
}
