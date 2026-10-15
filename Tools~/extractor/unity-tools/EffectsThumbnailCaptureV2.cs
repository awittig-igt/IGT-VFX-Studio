using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace EffectsExtractor.Editor
{
    /// <summary>
    /// Captures sanitized effect prefabs listed by the exporter manifest.
    /// Imported temporary prefabs are removed from the preview container afterward.
    /// </summary>
    public static class EffectsThumbnailCaptureV2
    {
        private const int Width = 640;
        private const int Height = 360;
        private const string GeneratedPrefabFolder = "Assets/EffectsExtractor/ParticlePackages";

        [Serializable]
        private sealed class ExportSelectionManifest
        {
            public bool sanitized;
            public List<ExportSelection> exports = new List<ExportSelection>();
        }

        [Serializable]
        private sealed class ExportSelection
        {
            public string effectType;
            public string name;
            public string captureAssetPath;
            public string prefabAssetPath;
            public bool sanitized;
        }

        [Serializable]
        private sealed class CaptureManifest
        {
            public List<CaptureEntry> captures = new List<CaptureEntry>();
        }

        [Serializable]
        private sealed class CaptureEntry
        {
            public string name;
            public string assetPath;
            public string thumbnail;
            public string effectType = "particle";
            public ParticleMetadata metadata;
        }

        [Serializable]
        private sealed class ParticleMetadata
        {
            public int particleSystemCount;
            public float duration;
            public bool looping;
            public int maxParticles;
            public float rateOverTime;
        }

        public static async void CaptureAllFromCommandLine()
        {
            var exitCode = 0;
            var allowAsyncCompilation = ShaderUtil.allowAsyncCompilation;
            ShaderUtil.allowAsyncCompilation = false;
            try
            {
                var output = GetArgument("-captureOutput");
                if (string.IsNullOrWhiteSpace(output))
                    throw new InvalidOperationException("-captureOutput is required.");

                var selectionManifestPath = GetArgument("-captureSelectionManifest");
                if (string.IsNullOrWhiteSpace(selectionManifestPath) ||
                    !File.Exists(selectionManifestPath))
                {
                    throw new InvalidOperationException(
                        "A valid -captureSelectionManifest is required for effect capture.");
                }

                var selections = ReadSelections(selectionManifestPath);
                var count = await CaptureSelections(output, selections);
                if (count != selections.Count)
                {
                    throw new InvalidOperationException(
                        "Captured " + count + " of " + selections.Count +
                        " sanitized effect prefabs.");
                }
            }
            catch (Exception exception)
            {
                Debug.LogException(exception);
                exitCode = 1;
            }
            finally
            {
                // BlankEffectsProject is a disposable preview container. Keep PNGs
                // outside the project and remove imported particle assets afterward.
                ShaderUtil.allowAsyncCompilation = allowAsyncCompilation;
                CleanupImportedParticleAssets();
                EditorApplication.Exit(exitCode);
            }
        }

        private static List<ExportSelection> ReadSelections(string manifestPath)
        {
            var manifest = JsonUtility.FromJson<ExportSelectionManifest>(
                File.ReadAllText(manifestPath));
            if (manifest == null || manifest.sanitized != true ||
                manifest.exports == null || manifest.exports.Count == 0)
            {
                throw new InvalidOperationException(
                    "The export manifest is not a sanitized effect manifest.");
            }

            var selections = new List<ExportSelection>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var selection in manifest.exports)
            {
                var assetPath = !string.IsNullOrWhiteSpace(selection.captureAssetPath)
                    ? selection.captureAssetPath
                    : selection.prefabAssetPath;
                if (selection.sanitized != true ||
                    string.IsNullOrWhiteSpace(assetPath) ||
                    !assetPath.StartsWith(
                        GeneratedPrefabFolder + "/",
                        StringComparison.OrdinalIgnoreCase) ||
                    !seen.Add(assetPath))
                {
                    throw new InvalidOperationException(
                        "Manifest contains a non-sanitized or duplicate capture path: " + assetPath);
                }

                if (string.IsNullOrEmpty(selection.effectType)) selection.effectType = "particle";
                if (selection.effectType != "particle" && selection.effectType != "vfx" && selection.effectType != "shader")
                    throw new InvalidOperationException("Unsupported effect type: " + selection.effectType);
                selection.captureAssetPath = assetPath;
                selections.Add(selection);
            }
            return selections;
        }

        private static async Task<int> CaptureSelections(
            string output,
            IReadOnlyList<ExportSelection> selections)
        {
            output = Path.GetFullPath(output);
            Directory.CreateDirectory(output);
            foreach (var oldPng in Directory.GetFiles(output, "*.png"))
                File.Delete(oldPng);

            var captureManifest = new CaptureManifest();
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var renderTexture = new RenderTexture(
                Width,
                Height,
                24,
                RenderTextureFormat.ARGB32);
            var cameraObject = new GameObject("_EffectsExtractorCamera");
            var camera = cameraObject.AddComponent<Camera>();
            camera.backgroundColor = new Color(0.025f, 0.025f, 0.035f, 1f);
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.fieldOfView = 48f;
            camera.nearClipPlane = 0.01f;
            camera.farClipPlane = 1000f;
            camera.targetTexture = renderTexture;
            camera.enabled = false;

            var lightObject = new GameObject("_EffectsExtractorLight");
            var light = lightObject.AddComponent<Light>();
            light.type = LightType.Directional;
            light.intensity = 1.2f;
            lightObject.transform.rotation = Quaternion.Euler(35f, -30f, 0f);

            try
            {
                foreach (var selection in selections)
                {
                    var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(
                        selection.captureAssetPath);
                    if (prefab == null)
                    {
                        throw new InvalidOperationException(
                            "Sanitized prefab was not imported: " + selection.captureAssetPath);
                    }

                    ValidateSanitizedPrefab(prefab, selection.captureAssetPath, selection.effectType);
                    var instance = PrefabUtility.InstantiatePrefab(prefab) as GameObject;
                    if (instance == null)
                    {
                        throw new InvalidOperationException(
                            "Could not instantiate " + selection.captureAssetPath);
                    }

                    try
                    {
                        instance.transform.position = Vector3.zero;
                        instance.transform.rotation = Quaternion.identity;
                        SetActiveRecursively(instance.transform);
                        if (selection.effectType == "particle") SimulateParticles(instance);
                        if (selection.effectType == "vfx") await SimulateVfx(instance, camera);
                        FrameCamera(camera, instance);
                        camera.Render();

                        var fileName = MakeSafeFileName(selection.name) + "-" +
                            GetAssetSuffix(selection.captureAssetPath) + ".png";
                        SaveCapture(renderTexture, Path.Combine(output, fileName));
                        captureManifest.captures.Add(new CaptureEntry
                        {
                            name = selection.name,
                            assetPath = selection.captureAssetPath,
                            thumbnail = fileName,
                            effectType = selection.effectType,
                            metadata = selection.effectType == "particle" ? ReadMetadata(instance) : null
                        });
                    }
                    finally
                    {
                        UnityEngine.Object.DestroyImmediate(instance);
                    }
                }
            }
            finally
            {
                camera.targetTexture = null;
                UnityEngine.Object.DestroyImmediate(cameraObject);
                UnityEngine.Object.DestroyImmediate(lightObject);
                renderTexture.Release();
                UnityEngine.Object.DestroyImmediate(renderTexture);
            }

            File.WriteAllText(
                Path.Combine(output, "capture-manifest.json"),
                JsonUtility.ToJson(captureManifest, true),
                new System.Text.UTF8Encoding(false));
            Debug.Log(
                "Effects Extractor captured " + captureManifest.captures.Count +
                " sanitized effect preview(s) to " + output);
            return captureManifest.captures.Count;
        }

        private static void ValidateSanitizedPrefab(GameObject prefab, string assetPath, string effectType)
        {
            var particleCount = prefab.GetComponentsInChildren<ParticleSystem>(true).Length;
            if (effectType == "particle" && particleCount == 0)
                throw new InvalidOperationException(
                    "Capture prefab has no ParticleSystem: " + assetPath);

            foreach (var transform in prefab.GetComponentsInChildren<Transform>(true))
            {
                if (GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(transform.gameObject) > 0)
                    throw new InvalidOperationException(
                        "Capture prefab contains a missing script: " + assetPath);

                foreach (var component in transform.gameObject.GetComponents<Component>())
                {
                    if (!IsAllowedComponent(component, effectType))
                    {
                        var typeName = component == null
                            ? "Missing Script"
                            : component.GetType().FullName;
                        throw new InvalidOperationException(
                            "Capture prefab contains unsupported component " +
                            typeName + ": " + assetPath);
                    }
                }
            }
        }

        private static bool IsVisualEffect(Component component)
        {
            return component != null && component.GetType().FullName == "UnityEngine.VFX.VisualEffect";
        }

        private static bool IsAllowedComponent(Component component, string effectType)
        {
            if (component is Transform) return true;
            if (effectType == "particle")
                return component is ParticleSystem || component is ParticleSystemRenderer;
            if (effectType == "shader") return component is MeshFilter || component is MeshRenderer;
            return IsVisualEffect(component) ||
                (component != null && component.GetType().FullName == "UnityEngine.VFX.VFXRenderer");
        }

        private static async Task SimulateVfx(GameObject instance, Camera camera)
        {
            var effects = instance.GetComponentsInChildren<Component>(true).Where(IsVisualEffect).ToArray();
            if (effects.Length == 0)
                throw new InvalidOperationException("VFX Graph component could not be imported. Check the preview template packages.");
            foreach (var effect in effects)
            {
                var type = effect.GetType();
                ((Behaviour)effect).enabled = true;
                if (type.GetProperty("visualEffectAsset").GetValue(effect) == null)
                    throw new InvalidOperationException("VFX Graph asset was not imported.");
                type.GetMethod("Reinit").Invoke(effect, null);
                type.GetMethod("Play", Type.EmptyTypes).Invoke(effect, null);
            }
            FrameCamera(camera, instance);
            camera.enabled = true;
            // Warm up the render pipeline and VFX GPU resources before sending spawn events.
            for (var frame = 0; frame < 30; frame++)
            {
                camera.Render();
                await NextEditorFrame();
                await Task.Delay(16);
            }
            foreach (var effect in effects)
            {
                effect.GetType().GetMethod("Reinit").Invoke(effect, null);
                effect.GetType().GetMethod("Play", Type.EmptyTypes).Invoke(effect, null);
            }
            // Render between simulation steps so GPU graph work is submitted in batch mode.
            for (var frame = 0; frame < 45; frame++)
            {
                foreach (var effect in effects)
                    effect.GetType().GetMethod("Simulate").Invoke(effect, new object[] { 1f / 30f, 1u });
                camera.Render();
                await NextEditorFrame();
                await Task.Delay(16);
            }
            foreach (var effect in effects)
                Debug.Log("[FindFX] VFX capture " + instance.name + ": " +
                    effect.GetType().GetProperty("aliveParticleCount").GetValue(effect) + " live particles.");
            camera.enabled = false;
        }

        private static Task NextEditorFrame()
        {
            var completion = new TaskCompletionSource<bool>();
            EditorApplication.CallbackFunction callback = null;
            callback = () =>
            {
                EditorApplication.update -= callback;
                completion.SetResult(true);
            };
            EditorApplication.update += callback;
            EditorApplication.QueuePlayerLoopUpdate();
            return completion.Task;
        }

        private static void SetActiveRecursively(Transform root)
        {
            root.gameObject.SetActive(true);
            for (var index = 0; index < root.childCount; index++)
                SetActiveRecursively(root.GetChild(index));
        }

        private static void SimulateParticles(GameObject instance)
        {
            var systems = instance.GetComponentsInChildren<ParticleSystem>(true);
            var targetTime = 0.75f;
            foreach (var particleSystem in systems)
            {
                var main = particleSystem.main;
                targetTime = Mathf.Max(
                    targetTime,
                    Mathf.Clamp(main.duration * 0.35f, 0.5f, 2.5f));
                particleSystem.useAutoRandomSeed = false;
                particleSystem.randomSeed = (uint)Math.Abs(
                    particleSystem.gameObject.name.GetHashCode());
                particleSystem.Clear(false);
            }

            const float step = 1f / 30f;
            for (var elapsed = 0f; elapsed < targetTime; elapsed += step)
            {
                foreach (var particleSystem in systems)
                    particleSystem.Simulate(step, false, false, true);
            }
        }

        private static void FrameCamera(Camera camera, GameObject instance)
        {
            var renderers = instance
                .GetComponentsInChildren<Renderer>(true)
                .Where(renderer => renderer.enabled)
                .ToArray();
            var hasBounds = false;
            var bounds = new Bounds(Vector3.zero, Vector3.one);
            foreach (var renderer in renderers)
            {
                var rendererBounds = renderer.bounds;
                if (!IsFinite(rendererBounds.center) || !IsFinite(rendererBounds.size))
                    continue;
                if (!hasBounds)
                {
                    bounds = rendererBounds;
                    hasBounds = true;
                }
                else
                {
                    bounds.Encapsulate(rendererBounds);
                }
            }

            if (!hasBounds || bounds.extents.sqrMagnitude < 0.0001f)
                bounds = new Bounds(Vector3.zero, Vector3.one * 2f);

            var radius = Mathf.Clamp(bounds.extents.magnitude, 0.5f, 50f);
            var distance = radius / Mathf.Tan(camera.fieldOfView * 0.5f * Mathf.Deg2Rad);
            distance = Mathf.Clamp(distance * 1.35f, 1.5f, 150f);
            camera.transform.position =
                bounds.center + new Vector3(0f, radius * 0.18f, -distance);
            camera.transform.LookAt(bounds.center);
            camera.nearClipPlane = Mathf.Max(0.01f, distance - radius * 2.5f);
            camera.farClipPlane = distance + radius * 3.5f;
        }

        private static bool IsFinite(Vector3 value)
        {
            return IsFinite(value.x) && IsFinite(value.y) && IsFinite(value.z);
        }

        private static bool IsFinite(float value)
        {
            return !float.IsNaN(value) && !float.IsInfinity(value);
        }

        private static ParticleMetadata ReadMetadata(GameObject instance)
        {
            var systems = instance.GetComponentsInChildren<ParticleSystem>(true);
            var metadata = new ParticleMetadata { particleSystemCount = systems.Length };
            if (systems.Length == 0)
                return metadata;

            var main = systems[0].main;
            var emission = systems[0].emission;
            metadata.duration = main.duration;
            metadata.looping = main.loop;
            metadata.maxParticles = main.maxParticles;
            metadata.rateOverTime = emission.rateOverTime.constant;
            return metadata;
        }

        private static void SaveCapture(RenderTexture renderTexture, string path)
        {
            var previous = RenderTexture.active;
            RenderTexture.active = renderTexture;
            var texture = new Texture2D(
                renderTexture.width,
                renderTexture.height,
                TextureFormat.RGBA32,
                false);
            try
            {
                texture.ReadPixels(
                    new Rect(0, 0, renderTexture.width, renderTexture.height),
                    0,
                    0);
                texture.Apply();
                File.WriteAllBytes(path, texture.EncodeToPNG());
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(texture);
                RenderTexture.active = previous;
            }
        }

        private static void CleanupImportedParticleAssets()
        {
            if (AssetDatabase.IsValidFolder(GeneratedPrefabFolder))
                AssetDatabase.DeleteAsset(GeneratedPrefabFolder);
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
        }

        private static string GetAssetSuffix(string assetPath)
        {
            var guid = AssetDatabase.AssetPathToGUID(assetPath);
            if (!string.IsNullOrWhiteSpace(guid))
                return guid.Substring(0, Math.Min(8, guid.Length));
            return Math.Abs(assetPath.GetHashCode()).ToString("x8");
        }

        private static string MakeSafeFileName(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
                value = "particle-effect";
            foreach (var invalid in Path.GetInvalidFileNameChars())
                value = value.Replace(invalid, '_');
            return value.Trim();
        }

        private static string GetArgument(string name)
        {
            var args = Environment.GetCommandLineArgs();
            for (var index = 0; index < args.Length - 1; index++)
            {
                if (string.Equals(args[index], name, StringComparison.OrdinalIgnoreCase))
                    return args[index + 1];
            }
            return null;
        }
    }
}
