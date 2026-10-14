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
        private Texture2D cardGradient;
        private enum Menu { Main, ViewFX, FindFX }
        [SerializeField] private Menu selectedMenu = Menu.Main;
        private Vector2 scrollPosition;
        private UnityWebRequest activeRequest;
        private Action<Reply> onReply;
        private bool cancelRequested;
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

        [MenuItem("Window/VFXStudio")]
        public static void Open() => GetWindow<ViewFXWindow>("VFXStudio");

        private void OnEnable()
        {
            titleContent = new GUIContent("VFXStudio");
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
            if (cardGradient != null) DestroyImmediate(cardGradient);
            cardGradient = null;
            activeRequest?.Abort();
            activeRequest?.Dispose();
            activeRequest = null;
        }

        private void RememberPending() => SessionState.SetString(StateKey, JsonUtility.ToJson(state));

        private void OnGUI()
        {
            using (var scroll = new EditorGUILayout.ScrollViewScope(scrollPosition))
            {
                scrollPosition = scroll.scrollPosition;
                if (selectedMenu == Menu.Main)
                {
                    DrawMainMenu();
                    return;
                }

                using (new EditorGUILayout.HorizontalScope())
                {
                    if (GUILayout.Button("Main Menu", GUILayout.Width(150), GUILayout.Height(36)))
                    {
                        selectedMenu = Menu.Main;
                        scrollPosition = Vector2.zero;
                    }
                    GUILayout.FlexibleSpace();
                    GUILayout.Label(selectedMenu == Menu.ViewFX ? "ViewFX" : "FindFX", EditorStyles.boldLabel);
                }
                EditorGUILayout.Space(12);
                DrawLogo(selectedMenu == Menu.ViewFX ? logo : findFXLogo);
                if (selectedMenu == Menu.ViewFX) DrawCompanion();
                else if (selectedMenu == Menu.FindFX)
                {
                    FindFXPanel.Draw();
                }
            }
        }

        private void DrawMainMenu()
        {
            EditorGUILayout.Space(12);
            EditorGUILayout.LabelField("VFXStudio", EditorStyles.boldLabel);
            EditorGUILayout.LabelField("Choose a tool to get started.", EditorStyles.wordWrappedLabel);
            EditorGUILayout.Space(12);

            if (position.width >= 580)
            {
                using (new EditorGUILayout.HorizontalScope()) DrawToolCards();
            }
            else DrawToolCards();
        }

        private void DrawToolCards()
        {
            DrawToolCard(Menu.ViewFX, logo, "ViewFX",
                "Connect your ViewFX account and download effects directly into your Unity project.");
            DrawToolCard(Menu.FindFX, findFXLogo, "FindFX",
                "Find particle effects in your scene, package them, and browse previews in your local gallery.");
        }

        private void DrawToolCard(Menu menu, Texture2D texture, string title, string description)
        {
            Color toolColor = menu == Menu.ViewFX
                ? new Color(0.44f, 0.34f, 0.72f)
                : new Color(0.72f, 0.23f, 0.29f);
            Color buttonColor = menu == Menu.ViewFX
                ? new Color(0.82f, 0.72f, 1f)
                : new Color(1f, 0.68f, 0.72f);
            using (var card = new EditorGUILayout.VerticalScope(EditorStyles.helpBox, GUILayout.ExpandWidth(true)))
            {
                if (Event.current.type == EventType.Repaint)
                    DrawCardGradient(card.rect, toolColor);
                EditorGUILayout.Space(8);
                DrawLogo(texture);
                EditorGUILayout.LabelField(title, EditorStyles.boldLabel);
                EditorGUILayout.LabelField(description, EditorStyles.wordWrappedLabel, GUILayout.MinHeight(54));
                EditorGUILayout.Space(8);
                if (TintedButton("Open " + title, buttonColor, GUILayout.Height(28)))
                {
                    selectedMenu = menu;
                    scrollPosition = Vector2.zero;
                }
                EditorGUILayout.Space(4);
            }
        }

        private void DrawCardGradient(Rect area, Color tint)
        {
            if (cardGradient == null)
            {
                const int height = 64;
                cardGradient = new Texture2D(1, height, TextureFormat.RGBA32, false)
                {
                    name = "ViewFX Card Gradient",
                    hideFlags = HideFlags.HideAndDontSave,
                    wrapMode = TextureWrapMode.Clamp,
                    filterMode = FilterMode.Bilinear
                };
                var pixels = new Color[height];
                for (int y = 0; y < height; y++)
                    pixels[y] = new Color(1, 1, 1, 0.18f * y / (height - 1));
                cardGradient.SetPixels(pixels);
                cardGradient.Apply(false, true);
            }

            // Fade the logo color into the native card background in either editor theme.
            area = new Rect(area.x + 2, area.y + 2, area.width - 4, area.height - 4);
            Color previousColor = GUI.color;
            try
            {
                GUI.color = tint;
                GUI.DrawTexture(area, cardGradient, ScaleMode.StretchToFill, true);
            }
            finally { GUI.color = previousColor; }
        }

        private static void DrawLogo(Texture2D texture)
        {
            if (texture != null)
            {
                Rect logoArea = GUILayoutUtility.GetRect(0, 80, GUILayout.ExpandWidth(true));
                float logoWidth = Mathf.Min(320, logoArea.width);
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
            EditorGUILayout.LabelField("Current Project:", new DirectoryInfo(Path.GetDirectoryName(Application.dataPath)).Name);
            EditorGUILayout.Space(4);
            bool connected = !string.IsNullOrEmpty(state.token);
            bool pending = !string.IsNullOrEmpty(state.id) && !cancelRequested;
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
                    float buttonHeight = GUI.skin.button.CalcSize(new GUIContent("Disconnect")).y * 2;
                    Rect buttonRow = GUILayoutUtility.GetRect(0, buttonHeight, GUILayout.ExpandWidth(true));
                    const float gap = 4;
                    float buttonWidth = (buttonRow.width - gap) / 2;
                    Rect disconnectRect = new Rect(buttonRow.x, buttonRow.y, buttonWidth, buttonHeight);
                    Rect checkRect = new Rect(disconnectRect.xMax + gap, buttonRow.y, buttonWidth, buttonHeight);
                    Color previousColor = GUI.backgroundColor;
                    bool disconnectClicked;
                    try
                    {
                        GUI.backgroundColor = previousColor * new Color(1f, 0.78f, 0.78f);
                        disconnectClicked = GUI.Button(disconnectRect, "Disconnect");
                    }
                    finally { GUI.backgroundColor = previousColor; }
                    bool checkClicked = GUI.Button(checkRect, "Check Connection");
                    if (disconnectClicked) Disconnect();
                    else if (checkClicked) Verify();
                }
                DrawMessages();
            }
            else if (pending)
            {
                using (new EditorGUILayout.HorizontalScope())
                {
                    GUILayout.FlexibleSpace();
                    if (GUILayout.Button("Open Browser Again", GUILayout.Width(150), GUILayout.Height(36)))
                        Application.OpenURL(state.approvalUrl);
                    GUILayout.Space(4);
                    using (new EditorGUI.DisabledScope(cancelRequested && activeRequest != null))
                        if (GUILayout.Button("Cancel", GUILayout.Width(150), GUILayout.Height(36))) Cancel();
                    GUILayout.FlexibleSpace();
                }
            }
            else
            {
                using (new EditorGUILayout.HorizontalScope())
                {
                    GUILayout.FlexibleSpace();
                    using (new EditorGUI.DisabledScope(activeRequest != null))
                        if (TintedButton("Connect to ViewFX", new Color(0.78f, 1f, 0.82f), GUILayout.Width(150), GUILayout.Height(36)))
                        {
                            if (cancelRequested) CancelConnection(true);
                            else Connect();
                        }
                    GUILayout.FlexibleSpace();
                }
            }
            if (!connected) DrawMessages();
        }

        internal static bool CenteredButton(string label)
        {
            using (new EditorGUILayout.HorizontalScope())
            {
                GUILayout.FlexibleSpace();
                bool clicked = GUILayout.Button(label, GUILayout.Width(150), GUILayout.Height(36));
                GUILayout.FlexibleSpace();
                return clicked;
            }
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

        private static bool TintedButton(string label, Color tint, params GUILayoutOption[] options)
        {
            Color previousColor = GUI.backgroundColor;
            try
            {
                GUI.backgroundColor = previousColor * tint;
                return GUILayout.Button(label, options);
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
            if (selectedMenu == Menu.FindFX && FindFXPanel.IsLaunching) Repaint();
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
            if (cancelRequested || activeRequest != null || string.IsNullOrEmpty(state.id) || EditorApplication.timeSinceStartup < nextPoll) return;
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

        private void Cancel() => CancelConnection(false);

        private void CancelConnection(bool reconnect)
        {
            cancelRequested = true;
            activeRequest?.Abort();
            activeRequest?.Dispose();
            activeRequest = null;
            onReply = null;
            message = "Cancelling connection...";
            Send("DELETE", "/api/unity/requests/" + state.id, state.pollToken, null, _ =>
            {
                Clear();
                if (reconnect) Connect();
                else ShowTemporaryMessage("Connection cancelled.");
            });
            Repaint();
        }

        private void Clear()
        {
            cancelRequested = false;
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
