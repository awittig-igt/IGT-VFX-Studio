using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace EffectsExtractor.Editor
{
    /// <summary>
    /// Creates disconnected, script-free effect prefabs before exporting packages.
    /// Source prefabs are never exported directly.
    /// </summary>
    public static class ParticlePackageExporterV2
    {
        public const string GeneratedPrefabFolder = "Assets/EffectsExtractor/ParticlePackages";

        private static readonly string[] ForbiddenDependencyExtensions =
        {
            ".cs", ".dll", ".asmdef", ".asmref", ".unity"
        };

        [Serializable]
        private sealed class ExportManifest
        {
            public int formatVersion = 5;
            public int duplicateCount;
            public bool sanitized = true;
            public string generatedAt;
            public string unityVersion = Application.unityVersion;
            public string previewPackageFile;
            public int skippedPackageDependencyCount;
            public List<ExportEntry> exports = new List<ExportEntry>();
            public List<string> warnings = new List<string>();
        }

        [Serializable]
        private sealed class ExportEntry
        {
            public string name;
            public string contentHash;
            public List<string> sourcePaths = new List<string>();
            public List<string> sourceNames = new List<string>();
            public int instanceCount;
            public string effectType = "particle";
            public string sourceKind;
            public string sourcePath;
            public string sourcePrefabAssetPath;
            public string sourceHierarchy;
            public string captureAssetPath;
            // Backward-compatible alias for older readers.
            public string prefabAssetPath;
            public string packageFile;
            public bool sanitized;
            public int particleSystemCount;
            public int dependencyCount;
            public int missingScriptCount;
            public int removedScriptCount;
            public int removedComponentCount;
            public int removedGameObjectCount;
            public string[] dependencies;
            public string[] warnings;
        }

        private sealed class SanitizeResult
        {
            public string assetPath;
            public int particleSystemCount;
            public int missingScriptCount;
            public int removedScriptCount;
            public int removedComponentCount;
            public int removedGameObjectCount;
            public readonly List<string> warnings = new List<string>();
        }

        private sealed class ExportSession
        {
            public readonly string outputFolder;
            public readonly ExportManifest manifest = new ExportManifest();
            public readonly HashSet<string> allDependencies =
                new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            private readonly Dictionary<string, ExportEntry> distinctEffects = new Dictionary<string, ExportEntry>();

            public ExportSession(string outputFolder)
            {
                this.outputFolder = Path.GetFullPath(outputFolder);
                Directory.CreateDirectory(this.outputFolder);
                manifest.generatedAt = DateTime.UtcNow.ToString("o");
            }

            public bool ExportPrefab(string path, string name,
                string sourceKind = "prefab", string sourceHierarchy = "")
            {
                var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                if (prefab == null)
                    throw new InvalidOperationException("Could not load source prefab.");
                return ExportSource(prefab, name, sourceKind, path, path, sourceHierarchy, path);
            }

            public bool ExportSceneObject(
                GameObject sourceRoot,
                string scenePath,
                string sourceHierarchy,
                string effectType = "particle")
            {
                var sourcePath = scenePath + "::" + sourceHierarchy;
                return ExportSource(sourceRoot, sourceRoot.name, "scene", sourcePath,
                    string.Empty, sourceHierarchy, sourcePath, effectType);
            }

            public bool ExportVfxPrefab(string path, GameObject prefab)
            {
                return ExportSource(prefab, prefab.name, "prefab", path, path, "", path, "vfx");
            }

            public bool ExportAsset(string path, string effectType)
            {
                var asset = AssetDatabase.LoadMainAssetAtPath(path);
                var root = effectType == "shader"
                    ? GameObject.CreatePrimitive(PrimitiveType.Sphere)
                    : new GameObject();
                try
                {
                    root.name = Path.GetFileNameWithoutExtension(path);
                    if (effectType == "shader")
                    {
                        var shader = AssetDatabase.LoadAssetAtPath<Shader>(path);
                        if (shader == null)
                            throw new InvalidOperationException("Could not load shader: " + path);
                        var materialPath = GeneratedPrefabFolder + "/" +
                            GetAssetSuffix(path, 12) + ".mat";
                        AssetDatabase.CreateAsset(new Material(shader), materialPath);
                        root.GetComponent<Renderer>().sharedMaterial =
                            AssetDatabase.LoadAssetAtPath<Material>(materialPath);
                    }
                    else
                    {
                        var type = GetVisualEffectType();
                        if (type == null || asset == null)
                            throw new InvalidOperationException("VFX Graph support is unavailable: " + path);
                        var effect = root.AddComponent(type);
                        type.GetProperty("visualEffectAsset").SetValue(effect, asset);
                    }
                    return ExportSource(root, root.name, "asset", path, "", "", path, effectType);
                }
                finally { UnityEngine.Object.DestroyImmediate(root); }
            }

            private bool ExportSource(
                GameObject sourceRoot,
                string displayName,
                string sourceKind,
                string sourcePath,
                string sourcePrefabAssetPath,
                string sourceHierarchy,
                string stableSourceKey,
                string effectType = "particle")
            {
                var typedKey = effectType == "particle" ? stableSourceKey : stableSourceKey + "::" + effectType;
                var sanitized = CreateSanitizedPrefab(sourceRoot, typedKey, displayName, effectType);
                AssetDatabase.SaveAssets();

                var allDependencyPaths = AssetDatabase
                    .GetDependencies(new[] { sanitized.assetPath }, true)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToArray();
                var packageDependencies = allDependencyPaths
                    .Where(path => path.StartsWith("Packages/", StringComparison.OrdinalIgnoreCase) ||
                                   path.StartsWith("Packages\\", StringComparison.OrdinalIgnoreCase))
                    .Where(path => !IsAllowedPackageDependency(path))
                    .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
                    .ToArray();
                if (packageDependencies.Length > 0)
                {
                    manifest.skippedPackageDependencyCount++;
                    var warning =
                        "Skipped because its sanitized effect prefab depends on non-standard package asset(s): " +
                        string.Join(", ", packageDependencies);
                    manifest.warnings.Add(displayName + ": " + warning);
                    Debug.LogWarning("[Effects Extractor] " + displayName + ": " + warning);
                    AssetDatabase.DeleteAsset(sanitized.assetPath);
                    return false;
                }

                var assetDependencies = allDependencyPaths
                    .Where(path => path.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase))
                    .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
                    .ToArray();

                ValidateDependencyClosure(sanitized.assetPath,
                    sourceKind == "asset" ? string.Empty : sourcePath, assetDependencies);
                var contentHash = GetContentHash(sanitized.assetPath, effectType);
                if (distinctEffects.TryGetValue(contentHash, out var existing))
                {
                    existing.instanceCount++;
                    if (!existing.sourcePaths.Contains(sourcePath)) existing.sourcePaths.Add(sourcePath);
                    if (!existing.sourceNames.Contains(displayName)) existing.sourceNames.Add(displayName);
                    manifest.duplicateCount++;
                    foreach (var warning in sanitized.warnings)
                        manifest.warnings.Add(displayName + ": " + warning);
                    if (sanitized.assetPath != existing.captureAssetPath)
                        AssetDatabase.DeleteAsset(sanitized.assetPath);
                    return false;
                }
                foreach (var dependency in assetDependencies)
                    allDependencies.Add(dependency);

                var suffix = GetAssetSuffix(typedKey, 8);
                var packagePath = Path.Combine(
                    outputFolder,
                    MakeSafeFileName(displayName) + "-" + suffix + ".unitypackage");
                AssetDatabase.ExportPackage(assetDependencies, packagePath, ExportPackageOptions.Default);

                var entry = new ExportEntry
                {
                    name = displayName,
                    contentHash = contentHash,
                    sourcePaths = new List<string> { sourcePath },
                    sourceNames = new List<string> { displayName },
                    instanceCount = 1,
                    effectType = effectType,
                    sourceKind = sourceKind,
                    sourcePath = sourcePath,
                    sourcePrefabAssetPath = sourcePrefabAssetPath,
                    sourceHierarchy = sourceHierarchy,
                    captureAssetPath = sanitized.assetPath,
                    prefabAssetPath = sanitized.assetPath,
                    packageFile = Path.GetFileName(packagePath),
                    sanitized = true,
                    particleSystemCount = sanitized.particleSystemCount,
                    dependencyCount = assetDependencies.Length,
                    missingScriptCount = sanitized.missingScriptCount,
                    removedScriptCount = sanitized.removedScriptCount,
                    removedComponentCount = sanitized.removedComponentCount,
                    removedGameObjectCount = sanitized.removedGameObjectCount,
                    dependencies = assetDependencies,
                    warnings = sanitized.warnings.ToArray()
                };
                manifest.exports.Add(entry);
                distinctEffects.Add(contentHash, entry);

                foreach (var warning in sanitized.warnings)
                    manifest.warnings.Add(displayName + ": " + warning);

                return true;
            }

            public void ExportPreviewPackage()
            {
                if (allDependencies.Count == 0)
                    return;

                var packagePath = Path.Combine(outputFolder, "effects-preview-import.unitypackage");
                AssetDatabase.ExportPackage(
                    allDependencies.OrderBy(path => path, StringComparer.OrdinalIgnoreCase).ToArray(),
                    packagePath,
                    ExportPackageOptions.Default);
                manifest.previewPackageFile = Path.GetFileName(packagePath);
            }

            public void SaveManifest()
            {
                File.WriteAllText(
                    Path.Combine(outputFolder, "particle-package-manifest.json"),
                    JsonUtility.ToJson(manifest, true),
                    new System.Text.UTF8Encoding(false));
            }
        }

        // Hash the sanitized hierarchy, not its source location or Unity's
        // generated IDs. Keep all serialized settings and asset references.
        private static string GetContentHash(string prefabPath, string effectType)
        {
            var root = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
            var objects = new List<UnityEngine.Object>();
            foreach (var transform in root.GetComponentsInChildren<Transform>(true))
            {
                objects.Add(transform.gameObject);
                objects.AddRange(transform.gameObject.GetComponents<Component>());
            }
            var references = new Dictionary<int, string> { [0] = "null" };
            for (var i = 0; i < objects.Count; i++)
                references[objects[i].GetInstanceID()] = "local:" + i;

            var text = new StringBuilder(effectType);
            foreach (var obj in objects)
            {
                text.Append('\n').Append(obj.GetType().FullName).Append('\n');
                var json = EditorJsonUtility.ToJson(obj);
                json = Regex.Replace(json, "\"instanceID\"\\s*:\\s*(-?\\d+)", match =>
                {
                    var id = int.Parse(match.Groups[1].Value);
                    if (!references.TryGetValue(id, out var reference))
                    {
                        var target = EditorUtility.InstanceIDToObject(id);
                        reference = target != null && AssetDatabase.TryGetGUIDAndLocalFileIdentifier(target, out string guid, out long fileId)
                            ? "asset:" + guid + ":" + fileId
                            : "external:" + id;
                        references[id] = reference;
                    }
                    return "\"instanceID\":\"" + reference + "\"";
                });
                // Only GameObject labels are cosmetic. Keep names inside VFX
                // property sheets, which identify exposed graph parameters.
                if (obj is GameObject)
                    json = Regex.Replace(json, "\"m_Name\"\\s*:\\s*\"(?:\\\\.|[^\"\\\\])*\"", "\"m_Name\":\"OBJECT\"");
                text.Append(json);
            }
            using (var hash = SHA256.Create())
                return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(text.ToString())))
                    .Replace("-", "").ToLowerInvariant();
        }


        public static void ExportProjectInteractive()
        {
            var output = GetDefaultOutputFolder();
            ExportProject(output, 0, true);
            EditorUtility.RevealInFinder(output);
        }

        /// <summary>
        /// Unity.exe -batchmode -quit -projectPath PROJECT
        ///   -executeMethod EffectsExtractor.Editor.ParticlePackageExporterV2.ExportProjectFromCommandLine
        ///   -particlePackageOutput OUTPUT
        ///   -particleExportLimit 0
        /// </summary>
        public static void ExportProjectFromCommandLine()
        {
            var output = GetArgument("-particlePackageOutput");
            if (string.IsNullOrWhiteSpace(output))
                output = GetDefaultOutputFolder();

            var limit = 0;
            int.TryParse(GetArgument("-particleExportLimit"), out limit);
            ExportProject(output, Math.Max(0, limit), false);
        }

        public static void ExportActiveScene(string output, string[] selectedAssetPaths,
            bool scanParticles = true, bool scanVfx = false, bool scanShaders = false)
        {
            if (!scanParticles && !scanVfx && !scanShaders)
                throw new InvalidOperationException("Enable at least one effect type to scan.");
            var scene = SceneManager.GetActiveScene();
            if (!scene.IsValid() || !scene.isLoaded)
                throw new InvalidOperationException("FindFX requires a loaded active scene.");
            if (EditorApplication.isPlayingOrWillChangePlaymode)
                throw new InvalidOperationException("Exit Play mode before running FindFX.");
            if (AssetDatabase.IsValidFolder(GeneratedPrefabFolder))
                throw new InvalidOperationException(
                    "FindFX's temporary prefab folder already exists. Move any assets you need " +
                    "out of " + GeneratedPrefabFolder + " and remove that folder before extraction.");

            ResetGeneratedPrefabFolder();
            var session = new ExportSession(output);
            try
            {
                var sceneKey = string.IsNullOrEmpty(scene.path) ? "unsaved:" + scene.name : scene.path;
                var roots = new HashSet<GameObject>();
                foreach (var particle in (scanParticles ? scene.GetRootGameObjects() : Array.Empty<GameObject>())
                    .SelectMany(root => root.GetComponentsInChildren<ParticleSystem>(true)))
                {
                    roots.Add(GetLocalParticleRoot(particle.gameObject));
                }
                // A particle root can contain another candidate; export the hierarchy only once.
                var candidates = roots.Where(root => !roots.Any(other =>
                    other != root && root.transform.IsChildOf(other.transform)));
                foreach (var root in candidates.OrderBy(root => GetHierarchyPath(root.transform),
                    StringComparer.Ordinal))
                    session.ExportSceneObject(root, sceneKey, GetHierarchyPath(root.transform));

                var assetPaths = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var path in selectedAssetPaths ?? Array.Empty<string>())
                {
                    if (!path.StartsWith("Assets/", StringComparison.Ordinal) && path != "Assets")
                        throw new InvalidOperationException("Select effect assets or folders under Assets: " + path);
                    if (AssetDatabase.IsValidFolder(path))
                    {
                        foreach (var guid in AssetDatabase.FindAssets("", new[] { path }))
                        {
                            var assetPath = AssetDatabase.GUIDToAssetPath(guid);
                            if (IsEffectAssetPath(assetPath)) assetPaths.Add(assetPath);
                        }
                    }
                    else if (IsEffectAssetPath(path)) assetPaths.Add(path);
                    else throw new InvalidOperationException("Not a prefab, shader or VFX Graph asset: " + path);
                }

                var shaderPaths = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
                var sceneRoots = scene.GetRootGameObjects();
                if (scanShaders)
                    foreach (var root in sceneRoots) CollectShaders(root, shaderPaths);
                if (scanVfx)
                {
                    var vfxRoots = sceneRoots.SelectMany(root => root.GetComponentsInChildren<Component>(true))
                        .Where(IsVisualEffect).Select(effect => effect.gameObject).Distinct().ToArray();
                    foreach (var root in vfxRoots.Where(root => !vfxRoots.Any(other =>
                        other != root && root.transform.IsChildOf(other.transform))))
                        session.ExportSceneObject(root, sceneKey, GetHierarchyPath(root.transform), "vfx");
                }

                foreach (var path in assetPaths)
                {
                    if (path.StartsWith(GeneratedPrefabFolder + "/", StringComparison.OrdinalIgnoreCase))
                        continue;
                    if (path.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase))
                    {
                        var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                        if (prefab == null)
                            throw new InvalidOperationException("Could not load selected prefab: " + path);
                        if (scanParticles && prefab.GetComponentsInChildren<ParticleSystem>(true).Length > 0)
                            session.ExportPrefab(path, prefab.name);
                        if (scanVfx && prefab.GetComponentsInChildren<Component>(true).Any(IsVisualEffect))
                            session.ExportVfxPrefab(path, prefab);
                        if (scanShaders) CollectShaders(prefab, shaderPaths);
                    }
                    else if (path.EndsWith(".vfx", StringComparison.OrdinalIgnoreCase))
                    {
                        if (scanShaders) CollectAssetShaders(path, shaderPaths);
                        if (scanVfx) session.ExportAsset(path, "vfx");
                    }
                    else if (scanShaders && IsShaderAssetPath(path)) shaderPaths.Add(path);
                }
                foreach (var shaderPath in shaderPaths) session.ExportAsset(shaderPath, "shader");
                if (session.manifest.exports.Count == 0)
                    throw new InvalidOperationException(
                        "No exportable effects of the enabled types in the active scene or selected asset scope. " +
                        "Check the Console for dependency warnings.");
                session.ExportPreviewPackage();
                session.SaveManifest();
                Debug.Log("[FindFX] Exported " + session.manifest.exports.Count +
                    " distinct effects; skipped " + session.manifest.duplicateCount +
                    " repeated instances. " + session.manifest.warnings.Count + " warning(s).");
            }
            finally
            {
                if (AssetDatabase.IsValidFolder(GeneratedPrefabFolder))
                    AssetDatabase.DeleteAsset(GeneratedPrefabFolder);
                DeleteEmptyParentFolder();
                AssetDatabase.SaveAssets();
                AssetDatabase.Refresh();
            }
        }

        private static void ExportProject(string output, int exportLimit, bool interactive)
        {
            ResetGeneratedPrefabFolder();
            var session = new ExportSession(output);
            try
            {
                var processedPrefabPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                ExportSceneCandidates(session, processedPrefabPaths, exportLimit);
                ExportRemainingPrefabCandidates(session, processedPrefabPaths, exportLimit);

                if (session.manifest.exports.Count == 0)
                    throw new InvalidOperationException(
                        session.manifest.skippedPackageDependencyCount > 0
                            ? "All particle effects were skipped because they depend on Unity packages."
                            : "No script-free particle prefab packages could be created.");

                session.ExportPreviewPackage();
                session.SaveManifest();
                AssetDatabase.SaveAssets();
                Debug.Log(
                    "Effects Extractor exported " + session.manifest.exports.Count +
                    " sanitized particle package(s) to " + session.outputFolder);
            }
            finally
            {
                // The source project is a scanner. Generated prefabs exist only
                // long enough to be written into the unitypackages.
                if (AssetDatabase.IsValidFolder(GeneratedPrefabFolder))
                    AssetDatabase.DeleteAsset(GeneratedPrefabFolder);
                DeleteEmptyParentFolder();
                AssetDatabase.SaveAssets();
                AssetDatabase.Refresh();
            }

            if (interactive)
            {
                EditorUtility.DisplayDialog(
                    "Effects Extractor",
                    "Sanitized particle packages were exported to:\n" + session.outputFolder,
                    "OK");
            }
        }

        private static void ExportRemainingPrefabCandidates(
            ExportSession session,
            HashSet<string> processedPrefabPaths,
            int exportLimit)
        {
            if (HasReachedLimit(session, exportLimit))
                return;

            var prefabGuids = AssetDatabase.FindAssets("t:Prefab", new[] { "Assets" });
            Array.Sort(prefabGuids, StringComparer.Ordinal);
            foreach (var guid in prefabGuids)
            {
                var sourcePath = AssetDatabase.GUIDToAssetPath(guid);
                if (processedPrefabPaths.Contains(sourcePath) ||
                    sourcePath.StartsWith(GeneratedPrefabFolder + "/", StringComparison.OrdinalIgnoreCase))
                    continue;

                var sourcePrefab = AssetDatabase.LoadAssetAtPath<GameObject>(sourcePath);
                if (sourcePrefab == null ||
                    sourcePrefab.GetComponentsInChildren<ParticleSystem>(true).Length == 0)
                    continue;

                processedPrefabPaths.Add(sourcePath);
                TryExportPrefab(session, sourcePath, sourcePrefab.name, "prefab", string.Empty);
                if (HasReachedLimit(session, exportLimit))
                    return;
            }
        }

        private static void ExportSceneCandidates(
            ExportSession session,
            HashSet<string> processedPrefabPaths,
            int exportLimit)
        {
            var sceneGuids = AssetDatabase.FindAssets("t:Scene", new[] { "Assets" });
            Array.Sort(sceneGuids, StringComparer.Ordinal);
            foreach (var guid in sceneGuids)
            {
                if (HasReachedLimit(session, exportLimit))
                    return;

                var scenePath = AssetDatabase.GUIDToAssetPath(guid);
                if (string.Equals(
                    scenePath,
                    "Assets/EffectsExtractor/EffectsCaptureScene.unity",
                    StringComparison.OrdinalIgnoreCase))
                    continue;

                var scene = SceneManager.GetSceneByPath(scenePath);
                var openedForScan = !scene.IsValid() || !scene.isLoaded;
                try
                {
                    if (openedForScan)
                        scene = EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Additive);

                    ExportCandidatesFromScene(
                        session, scene, scenePath, processedPrefabPaths, exportLimit);
                }
                catch (Exception exception)
                {
                    session.manifest.warnings.Add(scenePath + ": " + exception.Message);
                    Debug.LogWarning(
                        "[Effects Extractor] Could not scan scene " + scenePath + ": " + exception);
                }
                finally
                {
                    if (openedForScan && scene.IsValid() && scene.isLoaded)
                        EditorSceneManager.CloseScene(scene, true);
                }
            }
        }

        private static void ExportCandidatesFromScene(
            ExportSession session,
            Scene scene,
            string scenePath,
            HashSet<string> processedPrefabPaths,
            int exportLimit)
        {
            var sceneRoots = new HashSet<GameObject>();

            foreach (var particleSystem in scene.GetRootGameObjects()
                .SelectMany(root => root.GetComponentsInChildren<ParticleSystem>(true)))
            {
                sceneRoots.Add(GetLocalParticleRoot(particleSystem.gameObject));
            }

            var candidates = sceneRoots.Where(root => !sceneRoots.Any(other =>
                other != root && root.transform.IsChildOf(other.transform)));

            foreach (var sceneRoot in candidates
                .OrderBy(item => GetHierarchyPath(item.transform), StringComparer.OrdinalIgnoreCase))
            {
                var hierarchy = GetHierarchyPath(sceneRoot.transform);
                try
                {
                    session.ExportSceneObject(sceneRoot, scenePath, hierarchy);
                }
                catch (Exception exception)
                {
                    var source = scenePath + "::" + hierarchy;
                    session.manifest.warnings.Add(source + ": " + exception.Message);
                    Debug.LogWarning("[Effects Extractor] Skipped " + source + ": " + exception);
                }

                if (HasReachedLimit(session, exportLimit))
                    return;
            }
        }

        private static string GetHierarchyPath(Transform transform)
        {
            var segments = new Stack<string>();
            while (transform != null)
            {
                segments.Push(transform.name + "[" + transform.GetSiblingIndex() + "]");
                transform = transform.parent;
            }
            return string.Join("/", segments.ToArray());
        }

        private static bool HasReachedLimit(ExportSession session, int exportLimit)
        {
            return exportLimit > 0 && session.manifest.exports.Count >= exportLimit;
        }

        private static void TryExportPrefab(
            ExportSession session,
            string sourcePath,
            string displayName,
            string sourceKind,
            string sourceHierarchy)
        {
            try
            {
                session.ExportPrefab(sourcePath, displayName, sourceKind, sourceHierarchy);
            }
            catch (Exception exception)
            {
                session.manifest.warnings.Add(sourcePath + ": " + exception.Message);
                Debug.LogWarning("[Effects Extractor] Skipped " + sourcePath + ": " + exception);
            }
        }

        private static SanitizeResult CreateSanitizedPrefab(
            GameObject sourceRoot,
            string stableSourceKey,
            string displayName,
            string effectType = "particle")
        {
            if (sourceRoot == null)
                throw new InvalidOperationException("Could not load the particle source root.");

            EnsureGeneratedPrefabFolder();
            var assetPath = GeneratedPrefabFolder + "/" +
                MakeSafeFileName(displayName) + "-" +
                GetAssetSuffix(stableSourceKey, 12) + ".prefab";
            var result = new SanitizeResult { assetPath = assetPath };
            var previewScene = EditorSceneManager.NewPreviewScene();
            GameObject instance = null;

            try
            {
                if (PrefabUtility.IsPartOfPrefabAsset(sourceRoot))
                {
                    var sourcePrefabPath = AssetDatabase.GetAssetPath(sourceRoot);
                    var sourcePrefab = AssetDatabase.LoadAssetAtPath<GameObject>(sourcePrefabPath);
                    instance = PrefabUtility.InstantiatePrefab(sourcePrefab, previewScene) as GameObject;
                }
                else
                {
                    instance = UnityEngine.Object.Instantiate(sourceRoot);
                    if (instance == null)
                        throw new InvalidOperationException(
                            "Unity could not clone the scene particle source root.");
                    SceneManager.MoveGameObjectToScene(instance, previewScene);
                }

                if (instance == null)
                    throw new InvalidOperationException("Unity could not instantiate the particle source root.");

                if (PrefabUtility.IsPartOfPrefabInstance(instance))
                {
                    PrefabUtility.UnpackPrefabInstance(
                        instance,
                        PrefabUnpackMode.Completely,
                        InteractionMode.AutomatedAction);
                }

                instance.name = displayName;
                instance.transform.SetParent(null, false);
                instance.transform.localPosition = Vector3.zero;
                instance.transform.localRotation = Quaternion.identity;

                var originalTransforms = instance.GetComponentsInChildren<Transform>(true);
                var originalComponentCount = originalTransforms.Sum(item =>
                    item.gameObject.GetComponents<Component>().Count(component => component != null));
                result.missingScriptCount = originalTransforms.Sum(item =>
                    GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(item.gameObject));
                result.removedScriptCount = originalTransforms.Sum(item =>
                    item.gameObject.GetComponents<MonoBehaviour>().Count(script => script != null)) +
                    result.missingScriptCount;

                var retainedObjects = BuildRetainedObjectSet(instance, effectType);
                foreach (var transform in originalTransforms.OrderByDescending(GetHierarchyDepth))
                {
                    if (transform != null && transform.gameObject != instance &&
                        !retainedObjects.Contains(transform.gameObject))
                        UnityEngine.Object.DestroyImmediate(transform.gameObject);
                }

                foreach (var transform in instance.GetComponentsInChildren<Transform>(true))
                {
                    var gameObject = transform.gameObject;
                    GameObjectUtility.RemoveMonoBehavioursWithMissingScript(gameObject);

                    var components = gameObject.GetComponents<Component>();
                    for (var index = components.Length - 1; index >= 0; index--)
                    {
                        var component = components[index];
                        if (component == null || IsAllowedEffectComponent(component, effectType))
                            continue;
                        UnityEngine.Object.DestroyImmediate(component);
                    }

                    gameObject.tag = "Untagged";
                    gameObject.layer = 0;
                    GameObjectUtility.SetStaticEditorFlags(gameObject, (StaticEditorFlags)0);
                    gameObject.SetActive(true);
                }

                result.removedGameObjectCount =
                    originalTransforms.Length - instance.GetComponentsInChildren<Transform>(true).Length;
                var remainingComponentCount = instance
                    .GetComponentsInChildren<Transform>(true)
                    .Sum(item => item.gameObject.GetComponents<Component>()
                        .Count(component => component != null));
                result.removedComponentCount = Math.Max(
                    0,
                    originalComponentCount - remainingComponentCount + result.missingScriptCount);
                result.particleSystemCount =
                    instance.GetComponentsInChildren<ParticleSystem>(true).Length;

                if (effectType == "particle" && result.particleSystemCount == 0)
                    throw new InvalidOperationException("Sanitization removed every particle system.");

                var savedPrefab = PrefabUtility.SaveAsPrefabAsset(instance, assetPath);
                if (savedPrefab == null)
                    throw new InvalidOperationException("Unity could not save the sanitized prefab.");

                ValidateSanitizedPrefab(assetPath, effectType);
                return result;
            }
            finally
            {
                if (instance != null)
                    UnityEngine.Object.DestroyImmediate(instance);
                EditorSceneManager.ClosePreviewScene(previewScene);
            }
        }

        private static HashSet<GameObject> BuildRetainedObjectSet(GameObject root, string effectType)
        {
            var retained = new HashSet<GameObject>();
            foreach (var component in root.GetComponentsInChildren<Component>(true)
                .Where(component => effectType == "particle" ? component is ParticleSystem :
                    effectType == "vfx" ? IsVisualEffect(component) : component is MeshRenderer))
            {
                var cursor = component.transform;
                while (cursor != null)
                {
                    retained.Add(cursor.gameObject);
                    if (cursor.gameObject == root)
                        break;
                    cursor = cursor.parent;
                }
            }
            return retained;
        }

        private static void ValidateSanitizedPrefab(string assetPath, string effectType)
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
            if (prefab == null)
                throw new InvalidOperationException("The sanitized prefab could not be reloaded.");

            foreach (var transform in prefab.GetComponentsInChildren<Transform>(true))
            {
                if (GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(transform.gameObject) > 0)
                    throw new InvalidOperationException(
                        "Sanitized prefab still has a missing script reference.");

                foreach (var component in transform.gameObject.GetComponents<Component>())
                {
                    if (component == null || !IsAllowedEffectComponent(component, effectType))
                    {
                        var typeName = component == null ? "Missing Script" : component.GetType().FullName;
                        throw new InvalidOperationException(
                            "Sanitized prefab still contains unsupported component " + typeName + ".");
                    }
                }
            }
        }

        private static void ValidateDependencyClosure(
            string sanitizedPrefabPath,
            string sourcePrefabPath,
            IEnumerable<string> dependencies)
        {
            foreach (var dependency in dependencies)
            {
                var extension = Path.GetExtension(dependency);
                if (ForbiddenDependencyExtensions.Any(item =>
                    string.Equals(item, extension, StringComparison.OrdinalIgnoreCase)))
                {
                    throw new InvalidOperationException(
                        "Sanitized dependency closure contains forbidden asset: " + dependency);
                }

                if (dependency.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase) &&
                    !string.Equals(dependency, sanitizedPrefabPath, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException(
                        "Sanitized prefab still depends on another prefab: " + dependency);
                }

                if (string.Equals(dependency, sourcePrefabPath, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException(
                        "Sanitized prefab still depends on its source prefab.");
            }
        }

        private static GameObject GetLocalParticleRoot(GameObject gameObject)
        {
            var cursor = gameObject;
            while (cursor.transform.parent != null &&
                   cursor.transform.parent.GetComponent<ParticleSystem>() != null)
            {
                cursor = cursor.transform.parent.gameObject;
            }
            return cursor;
        }

        private static bool IsAllowedPackageDependency(string path)
        {
            if (!path.StartsWith("Packages/", StringComparison.OrdinalIgnoreCase) &&
                !path.StartsWith("Packages\\", StringComparison.OrdinalIgnoreCase))
                return true;

            var subPath = path.Substring(9);
            var slash = subPath.IndexOfAny(new[] { '/', '\\' });
            var packageName = slash >= 0 ? subPath.Substring(0, slash) : subPath;

            return packageName.StartsWith("com.unity.", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsEffectAssetPath(string path)
        {
            return path.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase) ||
                   path.EndsWith(".vfx", StringComparison.OrdinalIgnoreCase) || IsShaderAssetPath(path);
        }

        private static bool IsShaderAssetPath(string path)
        {
            return path.EndsWith(".shader", StringComparison.OrdinalIgnoreCase) ||
                   path.EndsWith(".shadergraph", StringComparison.OrdinalIgnoreCase);
        }

        private static Type GetVisualEffectType()
        {
            return AppDomain.CurrentDomain.GetAssemblies()
                .Select(assembly => assembly.GetType("UnityEngine.VFX.VisualEffect"))
                .FirstOrDefault(type => type != null);
        }

        private static bool IsVisualEffect(Component component)
        {
            return component != null && component.GetType().FullName == "UnityEngine.VFX.VisualEffect";
        }

        private static bool IsAllowedEffectComponent(Component component, string effectType)
        {
            if (component is Transform) return true;
            if (effectType == "particle") return IsAllowedParticleComponent(component);
            if (effectType == "shader") return component is MeshFilter || component is MeshRenderer;
            return IsVisualEffect(component) ||
                (component != null && component.GetType().FullName == "UnityEngine.VFX.VFXRenderer");
        }

        private static void CollectShaders(GameObject root, ISet<string> paths)
        {
            // Dependencies include shaders referenced by VFX Graph assets as well as materials.
            foreach (var component in root.GetComponentsInChildren<Component>(true))
            {
                if (component is Renderer renderer)
                    foreach (var material in renderer.sharedMaterials)
                        if (material != null) AddShader(material.shader, paths);
                if (IsVisualEffect(component))
                {
                    var graph = component.GetType().GetProperty("visualEffectAsset").GetValue(component)
                        as UnityEngine.Object;
                    var graphPath = AssetDatabase.GetAssetPath(graph);
                    CollectAssetShaders(graphPath, paths);
                }
            }
        }

        private static void CollectAssetShaders(string assetPath, ISet<string> paths)
        {
            if (string.IsNullOrEmpty(assetPath)) return;
            foreach (var dependency in AssetDatabase.GetDependencies(assetPath, true))
                if (IsShaderAssetPath(dependency) && dependency.StartsWith("Assets/")) paths.Add(dependency);
        }

        private static void AddShader(Shader shader, ISet<string> paths)
        {
            var path = AssetDatabase.GetAssetPath(shader);
            if (IsShaderAssetPath(path) && path.StartsWith("Assets/")) paths.Add(path);
        }

        private static bool IsAllowedParticleComponent(Component component)
        {
            return component is Transform ||
                   component is ParticleSystem ||
                   component is ParticleSystemRenderer;
        }

        private static int GetHierarchyDepth(Transform transform)
        {
            var depth = 0;
            while (transform != null)
            {
                depth++;
                transform = transform.parent;
            }
            return depth;
        }

        private static void ResetGeneratedPrefabFolder()
        {
            if (AssetDatabase.IsValidFolder(GeneratedPrefabFolder))
                AssetDatabase.DeleteAsset(GeneratedPrefabFolder);
            EnsureGeneratedPrefabFolder();
        }

        private static void EnsureGeneratedPrefabFolder()
        {
            if (!AssetDatabase.IsValidFolder("Assets/EffectsExtractor"))
                AssetDatabase.CreateFolder("Assets", "EffectsExtractor");
            if (!AssetDatabase.IsValidFolder(GeneratedPrefabFolder))
                AssetDatabase.CreateFolder("Assets/EffectsExtractor", "ParticlePackages");
        }

        private static void DeleteEmptyParentFolder()
        {
            const string parent = "Assets/EffectsExtractor";
            if (!AssetDatabase.IsValidFolder(parent))
                return;

            var absolute = Path.GetFullPath(Path.Combine(Application.dataPath, "..", parent));
            if (Directory.Exists(absolute) && Directory.GetFileSystemEntries(absolute).Length == 0)
                AssetDatabase.DeleteAsset(parent);
        }

        private static string GetAssetSuffix(string assetPath, int length)
        {
            var guid = AssetDatabase.AssetPathToGUID(assetPath);
            if (!string.IsNullOrWhiteSpace(guid))
                return guid.Substring(0, Math.Min(length, guid.Length));

            using (var sha = System.Security.Cryptography.SHA256.Create())
            {
                var bytes = System.Text.Encoding.UTF8.GetBytes(assetPath ?? string.Empty);
                var hash = BitConverter.ToString(sha.ComputeHash(bytes))
                    .Replace("-", string.Empty)
                    .ToLowerInvariant();
                return hash.Substring(0, Math.Min(length, hash.Length));
            }
        }

        private static string GetDefaultOutputFolder()
        {
            return Path.GetFullPath(Path.Combine(
                Application.dataPath, "..", "..", "ExtractedParticlePackages"));
        }

        private static string MakeSafeFileName(string value)
        {
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

