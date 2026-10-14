// EffectsThumbnailCapture.cs
// Place this file in any Editor/ folder inside your Unity project (e.g. Assets/Editor/).
// Menu: Effects Extractor > Capture Thumbnails
//
// Finds every prefab containing a ParticleSystem, renders it to a 512x512 PNG
// and saves the files to a ThumbnailCaptures/ folder beside your Assets/ folder.
// Then point the CLI extractor at that folder:
//   node index.js extract /path/to/project /path/to/output --thumbnails-dir ../ThumbnailCaptures

using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

public class EffectsThumbnailCapture : EditorWindow
{
    // ── Settings shown in the Editor window ──────────────────────────────
    private string  outputFolder  = "../ThumbnailCaptures";
    private int     resolution    = 512;
    private float   simulateTime  = 0.6f;
    private Color   bgColor       = new Color(0.08f, 0.08f, 0.10f, 1f);
    private bool    includeShaders = true;
    private bool    captureRunning = false;

    // ── Open window ───────────────────────────────────────────────────────
    [MenuItem("Effects Extractor/Capture Thumbnails")]
    public static void ShowWindow()
    {
        GetWindow<EffectsThumbnailCapture>("Effects Thumbnail Capture");
    }

    // ── Window UI ─────────────────────────────────────────────────────────
    private void OnGUI()
    {
        GUILayout.Label("Thumbnail Capture Settings", EditorStyles.boldLabel);
        EditorGUILayout.Space();

        outputFolder   = EditorGUILayout.TextField("Output Folder",   outputFolder);
        resolution     = EditorGUILayout.IntSlider("Resolution",      resolution, 128, 1024);
        simulateTime   = EditorGUILayout.Slider("Simulate Time (s)",  simulateTime, 0.1f, 3f);
        bgColor        = EditorGUILayout.ColorField("Background",     bgColor);
        includeShaders = EditorGUILayout.Toggle("Capture Shaders too", includeShaders);

        EditorGUILayout.Space();
        EditorGUILayout.HelpBox(
            "Output folder is relative to your project root (beside Assets/).\n" +
            "After capturing, run the CLI extractor with:\n" +
            "--thumbnails-dir " + outputFolder,
            MessageType.Info);

        EditorGUILayout.Space();

        GUI.enabled = !captureRunning;
        if (GUILayout.Button("Capture All Particle Thumbnails", GUILayout.Height(36)))
            CaptureAll();
        GUI.enabled = true;
    }

    // ── Main capture logic ────────────────────────────────────────────────
    private void CaptureAll()
    {
        // Resolve output path relative to project root
        string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
        string outDir      = Path.GetFullPath(Path.Combine(projectRoot, outputFolder));
        Directory.CreateDirectory(outDir);

        // Find every prefab that contains a ParticleSystem
        string[] guids        = AssetDatabase.FindAssets("t:Prefab");
        var      prefabPaths  = new List<string>();

        foreach (string guid in guids)
        {
            string     path   = AssetDatabase.GUIDToAssetPath(guid);
            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (prefab != null && prefab.GetComponentInChildren<ParticleSystem>() != null)
                prefabPaths.Add(path);
        }

        // Optionally find shaders to render on a sphere
        var shaderPaths = new List<string>();
        if (includeShaders)
        {
            foreach (string guid in AssetDatabase.FindAssets("t:Shader"))
            {
                string path = AssetDatabase.GUIDToAssetPath(guid);
                if (path.StartsWith("Assets/"))      // skip built-in shaders
                    shaderPaths.Add(path);
            }
        }

        int total   = prefabPaths.Count + shaderPaths.Count;
        int current = 0;

        // ── Set up a temporary off-screen camera ─────────────────────────
        var rtex    = new RenderTexture(resolution, resolution, 24, RenderTextureFormat.ARGB32);
        var camObj  = new GameObject("_ThumbnailCam") { hideFlags = HideFlags.HideAndDontSave };
        var cam     = camObj.AddComponent<Camera>();
        cam.backgroundColor = bgColor;
        cam.clearFlags      = CameraClearFlags.SolidColor;
        cam.fieldOfView     = 55f;
        cam.targetTexture   = rtex;
        cam.enabled         = false;

        // Spawn point out of the way of existing scene objects
        Vector3 origin = new Vector3(9999f, 0f, 0f);

        try
        {
            // ── Particle prefabs ──────────────────────────────────────────
            foreach (string prefabPath in prefabPaths)
            {
                string name = Path.GetFileNameWithoutExtension(prefabPath);
                EditorUtility.DisplayProgressBar("Capturing Thumbnails",
                    name, (float)current / total);

                try
                {
                    var prefab   = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
                    var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
                    instance.transform.position = origin;

                    // Simulate the particle system for a short time
                    foreach (var ps in instance.GetComponentsInChildren<ParticleSystem>())
                    {
                        ps.Simulate(simulateTime, true, true);
                        ps.Play();
                    }

                    // Position camera to frame the effect
                    FrameCamera(cam, instance, origin);

                    cam.Render();
                    SaveCapture(rtex, Path.Combine(outDir, name + ".png"));

                    DestroyImmediate(instance);
                }
                catch (System.Exception ex)
                {
                    Debug.LogWarning($"[EffectsThumbnailCapture] Skipped {name}: {ex.Message}");
                }

                current++;
            }

            // ── Shader sphere previews ────────────────────────────────────
            if (includeShaders)
            {
                var sphereObj = GameObject.CreatePrimitive(PrimitiveType.Sphere);
                sphereObj.transform.position   = origin;
                sphereObj.transform.localScale  = Vector3.one * 1.8f;
                sphereObj.hideFlags             = HideFlags.HideAndDontSave;

                var renderer = sphereObj.GetComponent<MeshRenderer>();

                cam.transform.position = origin + new Vector3(0, 0, -4f);
                cam.transform.LookAt(origin);

                foreach (string shaderPath in shaderPaths)
                {
                    string name = Path.GetFileNameWithoutExtension(shaderPath);
                    EditorUtility.DisplayProgressBar("Capturing Shader Thumbnails",
                        name, (float)current / total);

                    try
                    {
                        var shader = AssetDatabase.LoadAssetAtPath<Shader>(shaderPath);
                        if (shader == null) { current++; continue; }

                        var mat = new Material(shader);
                        renderer.sharedMaterial = mat;

                        cam.Render();
                        SaveCapture(rtex, Path.Combine(outDir, name + ".png"));

                        DestroyImmediate(mat);
                    }
                    catch (System.Exception ex)
                    {
                        Debug.LogWarning($"[EffectsThumbnailCapture] Skipped shader {name}: {ex.Message}");
                    }

                    current++;
                }

                DestroyImmediate(sphereObj);
            }

            AssetDatabase.Refresh();

            string msg = $"Captured {current} thumbnails to:\n{outDir}";
            Debug.Log("[EffectsThumbnailCapture] " + msg);
            EditorUtility.DisplayDialog("Capture Complete", msg, "OK");
        }
        finally
        {
            EditorUtility.ClearProgressBar();
            if (camObj  != null) DestroyImmediate(camObj);
            if (rtex    != null) rtex.Release();
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────
    private static void FrameCamera(Camera cam, GameObject target, Vector3 origin)
    {
        // Compute bounds of all renderers and particle systems
        Bounds bounds = new Bounds(origin + Vector3.up, Vector3.one * 2f);

        foreach (var r in target.GetComponentsInChildren<Renderer>())
            bounds.Encapsulate(r.bounds);

        // Step back far enough to see the whole effect
        float size     = Mathf.Max(bounds.size.magnitude, 1f);
        float distance = size * 1.8f / Mathf.Tan(cam.fieldOfView * 0.5f * Mathf.Deg2Rad);
        distance       = Mathf.Clamp(distance, 2f, 30f);

        cam.transform.position = bounds.center - Vector3.forward * distance + Vector3.up * size * 0.25f;
        cam.transform.LookAt(bounds.center);
    }

    private static void SaveCapture(RenderTexture rt, string path)
    {
        RenderTexture prev = RenderTexture.active;
        RenderTexture.active = rt;

        var tex = new Texture2D(rt.width, rt.height, TextureFormat.RGBA32, false);
        tex.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0);
        tex.Apply();

        File.WriteAllBytes(path, tex.EncodeToPNG());
        DestroyImmediate(tex);

        RenderTexture.active = prev;
    }
}
