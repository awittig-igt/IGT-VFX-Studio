using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace EffectsExtractor.Editor
{
    /// <summary>
    /// Creates disconnected, script-free particle prefabs before exporting packages.
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
            public int formatVersion = 3;
            public bool sanitized = true;
            public string generatedAt;
            public string previewPackageFile;
            public int skippedPackageDependencyCount;
            public List<ExportEntry> exports = new List<ExportEntry>();
            public List<string> warnings = new List<string>();
        }

        [Serializable]
        private sealed class ExportEntry
        {
            public string name;
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
                string sourceHierarchy)
            {
                var sourcePath = scenePath + "::" + sourceHierarchy;
                return ExportSource(sourceRoot, sourceRoot.name, "scene", sourcePath,
                    string.Empty, sourceHierarchy, sourcePath);
            }

            private bool ExportSource(
                GameObject sourceRoot,
                string displayName,
                string sourceKind,
                string sourcePath,
                string sourcePrefabAssetPath,
                string sourceHierarchy,
                string stableSourceKey)
            {
                var sanitized = CreateSanitizedPrefab(sourceRoot, stableSourceKey, displayName);
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
                        "Skipped because its particle-only prefab depends on non-standard package asset(s): " +
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

                ValidateDependencyClosure(sanitized.assetPath, sourcePath, assetDependencies);
                foreach (var dependency in assetDependencies)
                    allDependencies.Add(dependency);

                var suffix = GetAssetSuffix(stableSourceKey, 8);
                var packagePath = Path.Combine(
                    outputFolder,
                    MakeSafeFileName(displayName) + "-" + suffix + ".unitypackage");
                AssetDatabase.ExportPackage(assetDependencies, packagePath, ExportPackageOptions.Default);

                manifest.exports.Add(new ExportEntry
                {
                    name = displayName,
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
                });

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

        public static void ExportActiveScene(string output, string[] selectedAssetPaths)
        {
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
                foreach (var particle in scene.GetRootGameObjects()
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

                var prefabPaths = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var path in selectedAssetPaths ?? Array.Empty<string>())
                {
                    if (!path.StartsWith("Assets/", StringComparison.Ordinal) && path != "Assets")
                        throw new InvalidOperationException("Select prefab assets or folders under Assets: " + path);
                    if (AssetDatabase.IsValidFolder(path))
                    {
                        foreach (var guid in AssetDatabase.FindAssets("t:Prefab", new[] { path }))
                            prefabPaths.Add(AssetDatabase.GUIDToAssetPath(guid));
                    }
                    else if (path.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase))
                        prefabPaths.Add(path);
                    else
                        throw new InvalidOperationException("Not a prefab asset or folder: " + path);
                }
                foreach (var path in prefabPaths)
                {
                    if (path.StartsWith(GeneratedPrefabFolder + "/", StringComparison.OrdinalIgnoreCase))
                        continue;
                    var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                    if (prefab == null)
                        throw new InvalidOperationException("Could not load selected prefab: " + path);
                    if (prefab.GetComponentsInChildren<ParticleSystem>(true).Length > 0)
                        session.ExportPrefab(path, prefab.name);
                }
                if (session.manifest.exports.Count == 0)
                    throw new InvalidOperationException(
                        "No exportable particles in the active scene or selected prefab scope. " +
                        "Check the Console for dependency warnings.");
                session.ExportPreviewPackage();
                session.SaveManifest();
                Debug.Log("[FindFX] Exported " + session.manifest.exports.Count +
                    " particle effects. " + session.manifest.warnings.Count + " warning(s).");
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
            string displayName)
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

                var retainedObjects = BuildRetainedObjectSet(instance);
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
                        if (component == null || IsAllowedParticleComponent(component))
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

                if (result.particleSystemCount == 0)
                    throw new InvalidOperationException("Sanitization removed every particle system.");

                var savedPrefab = PrefabUtility.SaveAsPrefabAsset(instance, assetPath);
                if (savedPrefab == null)
                    throw new InvalidOperationException("Unity could not save the sanitized prefab.");

                ValidateSanitizedPrefab(assetPath);
                return result;
            }
            finally
            {
                if (instance != null)
                    UnityEngine.Object.DestroyImmediate(instance);
                EditorSceneManager.ClosePreviewScene(previewScene);
            }
        }

        private static HashSet<GameObject> BuildRetainedObjectSet(GameObject root)
        {
            var retained = new HashSet<GameObject>();
            foreach (var particleSystem in root.GetComponentsInChildren<ParticleSystem>(true))
            {
                var cursor = particleSystem.transform;
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

        private static void ValidateSanitizedPrefab(string assetPath)
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
                    if (component == null || !IsAllowedParticleComponent(component))
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

