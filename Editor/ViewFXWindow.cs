using System;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.Networking;

namespace ViewFX.Editor
{
    public sealed class ViewFXWindow : EditorWindow
    {
        [Serializable] private class Account { public string name; public string email; }
        [Serializable] private class State
        {
            public string siteUrl = "http://localhost:5173";
            public string id, pollToken, approvalUrl, expiresAt, token;
            public Account user;
        }
        [Serializable] private class Reply
        {
            public string id, pollToken, approvalUrl, expiresAt, status, token, error;
            public Account user;
        }
        [Serializable] private class ProjectRequest { public string projectName; public string unityVersion; }

        private State state = new State();
        private Texture2D logo;
        private Texture2D findFXLogo;
        [SerializeField] private int selectedTab;
        private static readonly string[] TabNames = { "ViewFX", "FindFX" };
        private UnityWebRequest activeRequest;
        private Action<Reply> onReply;
        private double nextPoll;
        private const double MessageDuration = 5;
        private double messageExpiresAt;
        private string messageText = "Connect your ViewFX account.";
        private string message
        {
            get => messageText;
            set { messageText = value; messageExpiresAt = 0; }
        }
        private string lastDownloadStatus;
        private double downloadMessageExpiresAt;
        private string StateKey => "ViewFX.Pending." + CredentialStore.ProjectKey;

        [InitializeOnLoadMethod]
        private static void PromptOnInstall()
        {
            EditorApplication.delayCall += () =>
            {
                if (Application.isBatchMode) return;
                string key = "ViewFX.Prompted." + CredentialStore.ProjectKey;
                if (EditorPrefs.GetBool(key)) return;
                EditorPrefs.SetBool(key, true);
                Open();
            };
        }

        [MenuItem("Window/ViewFX")]
        public static void Open() => GetWindow<ViewFXWindow>("ViewFX");

        private void OnEnable()
        {
            minSize = new Vector2(340, 270);
            string scriptPath = AssetDatabase.GetAssetPath(MonoScript.FromScriptableObject(this));
            logo = AssetDatabase.LoadAssetAtPath<Texture2D>(
                Path.GetDirectoryName(scriptPath).Replace('\\', '/') + "/ViewFXLogo.png");
            findFXLogo = AssetDatabase.LoadAssetAtPath<Texture2D>(
                Path.GetDirectoryName(scriptPath).Replace('\\', '/') + "/FindFXLogo.png");
            try
            {
                string saved = CredentialStore.Load();
                if (string.IsNullOrEmpty(saved)) saved = SessionState.GetString(StateKey, "");
                if (!string.IsNullOrEmpty(saved)) state = JsonUtility.FromJson<State>(saved);
                if (!string.IsNullOrEmpty(state.token)) Verify();
            }
            catch (Exception error) { message = error.Message; }
            EditorApplication.update += Tick;
        }

        private void OnDisable()
        {
            EditorApplication.update -= Tick;
            activeRequest?.Abort();
            activeRequest?.Dispose();
            activeRequest = null;
        }

        private void RememberPending() => SessionState.SetString(StateKey, JsonUtility.ToJson(state));

        private void OnGUI()
        {
            selectedTab = GUILayout.Toolbar(selectedTab, TabNames);
            EditorGUILayout.Space(12);
            DrawLogo(selectedTab == 0 ? logo : findFXLogo);
            if (selectedTab == 0) DrawCompanion();
        }

        private static void DrawLogo(Texture2D texture)
        {
            if (texture != null)
            {
                Rect logoArea = GUILayoutUtility.GetRect(0, 64, GUILayout.ExpandWidth(true));
                float logoWidth = Mathf.Min(256, logoArea.width);
                Rect logoRect = new Rect(logoArea.center.x - logoWidth / 2, logoArea.y, logoWidth, logoArea.height);
                Color previousColor = GUI.color;
                try
                {
                    GUI.color = Color.white;
                    GUI.DrawTexture(logoRect, texture, ScaleMode.ScaleToFit, true);
                }
                finally
                {
                    GUI.color = previousColor;
                }
                EditorGUILayout.Space(8);
            }
        }

        private void DrawCompanion()
        {
            EditorGUILayout.LabelField("ViewFX Manager", EditorStyles.boldLabel);
            EditorGUILayout.LabelField("Current Project:", new DirectoryInfo(Path.GetDirectoryName(Application.dataPath)).Name);
            EditorGUILayout.Space(4);
            bool connected = !string.IsNullOrEmpty(state.token);
            bool pending = !string.IsNullOrEmpty(state.id);
            using (new EditorGUI.DisabledScope(connected || pending || activeRequest != null))
                state.siteUrl = EditorGUILayout.TextField("ViewFX site:", state.siteUrl);
            if (connected)
            {
                EditorGUILayout.Space(8);
                using (new EditorGUILayout.VerticalScope(EditorStyles.helpBox))
                {
                    EditorGUILayout.Space(4);
                    EditorGUILayout.LabelField("Account information", EditorStyles.boldLabel);
                    EditorGUILayout.Space(4);
                    EditorGUILayout.LabelField("Name", EditorStyles.miniLabel);
                    EditorGUILayout.SelectableLabel(
                        string.IsNullOrEmpty(state.user?.name) ? "Not available" : state.user.name,
                        EditorStyles.label, GUILayout.Height(EditorGUIUtility.singleLineHeight));
                    EditorGUILayout.LabelField("Email", EditorStyles.miniLabel);
                    EditorGUILayout.SelectableLabel(
                        string.IsNullOrEmpty(state.user?.email) ? "Not available" : state.user.email,
                        EditorStyles.label, GUILayout.Height(EditorGUIUtility.singleLineHeight));
                    EditorGUILayout.Space(4);
                }
                EditorGUILayout.Space(8);
#if !UNITY_EDITOR_WIN
                EditorGUILayout.HelpBox("This connection lasts until Unity closes on this platform.", MessageType.Info);
#endif
                using (new EditorGUI.DisabledScope(activeRequest != null))
                {
                    if (TintedButton("Disconnect", new Color(1f, 0.78f, 0.78f))) Disconnect();
                    if (GUILayout.Button("Check Connection")) Verify();
                }
                DrawMessages();
            }
            else if (pending)
            {
                if (GUILayout.Button("Open Browser Again")) Application.OpenURL(state.approvalUrl);
                using (new EditorGUI.DisabledScope(activeRequest != null))
                    if (GUILayout.Button("Cancel")) Cancel();
            }
            else
            {
                using (new EditorGUI.DisabledScope(activeRequest != null))
                    if (TintedButton("Connect to ViewFX", new Color(0.78f, 1f, 0.82f))) Connect();
            }
            if (!connected) DrawMessages();
        }

        private void DrawMessages()
        {
            DrawMessage(message, messageExpiresAt);
            DrawMessage(DownloadService.Status, downloadMessageExpiresAt);
        }

        private void ShowTemporaryMessage(string text)
        {
            message = text;
            messageExpiresAt = EditorApplication.timeSinceStartup + MessageDuration;
        }

        private static void DrawMessage(string text, double expiresAt)
        {
            double now = EditorApplication.timeSinceStartup;
            if (string.IsNullOrEmpty(text) || (expiresAt > 0 && now >= expiresAt)) return;
            using (new EditorGUILayout.VerticalScope(EditorStyles.helpBox))
            {
                using (new EditorGUILayout.HorizontalScope())
                {
                    GUILayout.Label(EditorGUIUtility.IconContent("console.infoicon"),
                        GUILayout.Width(24), GUILayout.Height(24));
                    EditorGUILayout.LabelField(text, EditorStyles.wordWrappedLabel);
                }
                if (expiresAt > 0)
                {
                    Rect bar = GUILayoutUtility.GetRect(0, 3, GUILayout.ExpandWidth(true));
                    EditorGUI.DrawRect(bar, new Color(0.5f, 0.5f, 0.5f, 0.2f));
                    bar.width *= Mathf.Clamp01((float)((expiresAt - now) / MessageDuration));
                    EditorGUI.DrawRect(bar, new Color(0.45f, 0.75f, 0.55f));
                    EditorGUILayout.Space(2);
                }
            }
        }

        private static bool TintedButton(string label, Color tint)
        {
            Color previousColor = GUI.backgroundColor;
            try
            {
                GUI.backgroundColor = previousColor * tint;
                return GUILayout.Button(label);
            }
            finally
            {
                GUI.backgroundColor = previousColor;
            }
        }

        private void Connect()
        {
            if (!Uri.TryCreate(state.siteUrl.Trim(), UriKind.Absolute, out var uri) ||
                (uri.Scheme != "https" && !(uri.Scheme == "http" && uri.IsLoopback)) ||
                !string.IsNullOrEmpty(uri.UserInfo) || uri.AbsolutePath != "/" || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
            {
                message = "Enter an HTTPS site address, or HTTP localhost for development.";
                return;
            }
            state.siteUrl = uri.GetLeftPart(UriPartial.Authority);
            message = "Starting connection...";
            Send("POST", "/api/unity/requests", "", JsonUtility.ToJson(new ProjectRequest {
                projectName = new DirectoryInfo(Path.GetDirectoryName(Application.dataPath)).Name,
                unityVersion = Application.unityVersion
            }), reply =>
            {
                if (!Uri.TryCreate(reply.approvalUrl, UriKind.Absolute, out var approval) || approval.GetLeftPart(UriPartial.Authority) != state.siteUrl)
                { message = "The server returned a different site address. Check ViewFX site configuration."; return; }
                state.id = reply.id;
                state.pollToken = reply.pollToken;
                state.approvalUrl = reply.approvalUrl;
                state.expiresAt = reply.expiresAt;
                RememberPending();
                message = "Waiting for Allow or Deny in your browser...";
                Application.OpenURL(state.approvalUrl);
            });
        }

        private void Tick()
        {
            double now = EditorApplication.timeSinceStartup;
            if (lastDownloadStatus != DownloadService.Status)
            {
                lastDownloadStatus = DownloadService.Status;
                downloadMessageExpiresAt = lastDownloadStatus == "Download complete. Review the package in Unity's import dialog."
                    ? now + MessageDuration : 0;
                Repaint();
            }
            if (messageExpiresAt > 0)
            {
                if (now >= messageExpiresAt) message = "";
                Repaint();
            }
            if (downloadMessageExpiresAt > 0 && now <= downloadMessageExpiresAt + 0.1) Repaint();
            if (activeRequest != null)
            {
                if (!activeRequest.isDone) return;
                var completed = activeRequest;
                var callback = onReply;
                activeRequest = null;
                onReply = null;
                try
                {
                    Reply reply = null;
                    try { reply = JsonUtility.FromJson<Reply>(completed.downloadHandler.text); } catch (ArgumentException) { }
                    if (completed.result != UnityWebRequest.Result.Success)
                    {
                        if (completed.responseCode == 401) Clear();
                        message = reply?.error ?? "Could not reach ViewFX. Check your connection and try again.";
                    }
                    else if (reply != null) callback(reply);
                    else message = "ViewFX returned an invalid response. Try again.";
                }
                catch (Exception error) { message = "Could not complete connection: " + error.Message; }
                finally { completed.Dispose(); Repaint(); }
            }
            if (activeRequest != null || string.IsNullOrEmpty(state.id) || EditorApplication.timeSinceStartup < nextPoll) return;
            if (DateTimeOffset.TryParse(state.expiresAt, out var expiry) && expiry <= DateTimeOffset.UtcNow)
            { Clear(); message = "Connection request expired. Connect again to retry."; Repaint(); return; }
            nextPoll = EditorApplication.timeSinceStartup + 3;
            Send("POST", "/api/unity/requests/" + state.id + "/poll", state.pollToken, "{}", reply =>
            {
                if (reply.status == "connected")
                {
                    // Persist before discarding the pending request, so storage failure can be retried.
                    var connected = new State { siteUrl = state.siteUrl, token = reply.token, user = reply.user };
                    CredentialStore.Save(JsonUtility.ToJson(connected));
                    state = connected;
                    SessionState.EraseString(StateKey);
                    ShowTemporaryMessage("Connected to ViewFX.");
                }
                else if (reply.status != "pending")
                {
                    Clear();
                    message = reply.status == "denied" ? "Connection denied. You can connect again." : "Connection request expired or cancelled. Connect again to retry.";
                }
            });
        }

        private void Verify() => Send("GET", "/api/unity/connection", state.token, null, reply =>
        { state.user = reply.user; ShowTemporaryMessage("Connected to ViewFX."); });

        private void Disconnect()
        {
            message = "Disconnecting...";
            Send("DELETE", "/api/unity/connection", state.token, null, _ =>
            { Clear(); ShowTemporaryMessage("Disconnected from ViewFX."); });
        }

        private void Cancel() => Send("DELETE", "/api/unity/requests/" + state.id, state.pollToken, null, _ =>
        { Clear(); ShowTemporaryMessage("Connection cancelled."); });

        private void Clear()
        {
            CredentialStore.Clear();
            SessionState.EraseString(StateKey);
            state = new State { siteUrl = state.siteUrl };
        }

        private void Send(string method, string path, string token, string body, Action<Reply> callback)
        {
            activeRequest = new UnityWebRequest(state.siteUrl + path, method) { downloadHandler = new DownloadHandlerBuffer(), timeout = 15, redirectLimit = 0 };
            if (body != null)
            {
                activeRequest.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
                activeRequest.SetRequestHeader("Content-Type", "application/json");
            }
            if (!string.IsNullOrEmpty(token)) activeRequest.SetRequestHeader("Authorization", "Bearer " + token);
            onReply = callback;
            activeRequest.SendWebRequest();
        }
    }
}
