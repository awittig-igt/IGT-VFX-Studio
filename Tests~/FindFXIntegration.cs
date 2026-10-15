using System;
using System.IO;
using System.Linq;
using EffectsExtractor.Editor;
using UnityEditor;
using PackageInfo = UnityEditor.PackageManager.PackageInfo;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

public static class FindFXIntegration
{
    [Serializable]
    private sealed class Manifest
    {
        public Entry[] exports;
        public int duplicateCount;
    }

    [Serializable]
    private sealed class Entry
    {
        public string name;
        public string effectType;
        public string sourceKind;
        public string packageFile;
        public string captureAssetPath;
        public int particleSystemCount;
        public string contentHash;
        public string[] sourcePaths;
    }

    public static void Run()
    {
        var output = Environment.GetEnvironmentVariable("FINDFX_TEST_OUTPUT");
        if (string.IsNullOrEmpty(output))
            throw new InvalidOperationException("FINDFX_TEST_OUTPUT is required.");
        var package = PackageInfo.FindForAssembly(typeof(ViewFX.Editor.ViewFXWindow).Assembly);
        Assert(package != null && File.Exists(Path.Combine(package.resolvedPath, "Tools~", "serve.ps1")),
            "Standalone package did not include its runtime.");
        var shader = Shader.Find("FindFXTests/Particle");
        Assert(shader != null, "Test particle shader was not imported.");
        AssetDatabase.CreateAsset(new Material(shader), "Assets/TestParticle.mat");
        AssetDatabase.CreateFolder("Assets", "Curated");
        AssetDatabase.CreateFolder("Assets", "Unrelated");
        var prefabSource = Particle("PrefabSource", 1);
        var prefab = PrefabUtility.SaveAsPrefabAsset(prefabSource, "Assets/Curated/Curated.prefab");
        UnityEngine.Object.DestroyImmediate(prefabSource);
        var unrelated = Particle("UnrelatedPrefab", 1);
        PrefabUtility.SaveAsPrefabAsset(unrelated, "Assets/Unrelated/Unrelated.prefab");
        UnityEngine.Object.DestroyImmediate(unrelated);

        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        var parent = new GameObject("NonParticleParent");
        var loose = Particle("LooseInactive", 1);
        loose.transform.SetParent(parent.transform);
        loose.SetActive(false);
        var nested = Particle("NestedParticle", 1);
        nested.transform.SetParent(loose.transform);
        var first = (GameObject)PrefabUtility.InstantiatePrefab(prefab, scene);
        first.name = "InstanceOverride";
        var main = first.GetComponent<ParticleSystem>().main;
        var second = (GameObject)PrefabUtility.InstantiatePrefab(prefab, scene);
        second.name = "SecondInstance";
        var duplicate = (GameObject)PrefabUtility.InstantiatePrefab(prefab, scene);
        duplicate.name = "ZRepeatedCopy";
        duplicate.transform.position = new Vector3(100, 200, 300);
        EditorSceneManager.SaveScene(scene, "Assets/TestScene.unity");
        var otherScene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Additive);
        Particle("OtherSceneParticle", 1);
        SceneManager.SetActiveScene(scene);
        first.GetComponent<ParticleSystem>().Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
        main.startLifetime = 7;
        main.duration = 7;
        PrefabUtility.RecordPrefabInstancePropertyModifications(first.GetComponent<ParticleSystem>());
        EditorSceneManager.MarkSceneDirty(scene);

        ParticlePackageExporterV2.ExportActiveScene(Path.Combine(output, "scene-only"), Array.Empty<string>());
        var sceneOnly = ReadManifest(Path.Combine(output, "scene-only"));
        Assert(sceneOnly.exports.Length == 3, "Scene-only must export three unique particle hierarchies.");
        Assert(sceneOnly.duplicateCount == 1 && sceneOnly.exports.Any(entry => entry.sourcePaths.Length == 2),
            "Repeated scene instances must share a package and retain both source paths.");
        Assert(sceneOnly.exports.All(entry => entry.sourceKind == "scene"), "Scene-only scanned prefab assets.");
        Assert(sceneOnly.exports.Any(entry => entry.name == "LooseInactive" && entry.particleSystemCount == 2),
            "Inactive particles and nested particle systems must be included without duplicate roots.");
        Assert(sceneOnly.exports.All(entry => entry.name != "OtherSceneParticle"), "Other loaded scene was scanned.");
        Assert(!AssetDatabase.IsValidFolder(ParticlePackageExporterV2.GeneratedPrefabFolder),
            "Generated prefabs were not cleaned up.");
        Assert(!loose.activeSelf && main.startLifetime.constant == 7 && otherScene.isLoaded,
            "Source objects or loaded scenes were modified.");

        ParticlePackageExporterV2.ExportActiveScene(Path.Combine(output, "packages"),
            new[] { "Assets/Curated", "Assets/Curated/Curated.prefab" });
        var curated = ReadManifest(Path.Combine(output, "packages"));
        Assert(curated.exports.Length == 3 && curated.duplicateCount == 2,
            "Scene copies and their selected source prefab must share one package.");
        Assert(curated.exports.Any(entry => entry.sourcePaths.Contains("Assets/Curated/Curated.prefab")),
            "Selected prefab provenance was lost during deduplication.");

        ParticlePackageExporterV2.ExportActiveScene(Path.Combine(output, "shaders-only"),
            new[] { "Assets/FindFXTestParticle.shader" }, false, false, true);
        var shaders = ReadManifest(Path.Combine(output, "shaders-only"));
        Assert(shaders.exports.Length == 1 && shaders.exports[0].effectType == "shader",
            "Shader scan must deduplicate scene and selected shaders and exclude particles.");

        var vfxPackage = UnityEditor.PackageManager.PackageInfo.GetAllRegisteredPackages()
            .First(item => item.name == "com.unity.visualeffectgraph");
        var template = Directory.GetFiles(vfxPackage.resolvedPath, "*.vfx", SearchOption.AllDirectories)
            .First(path => Path.GetFileName(path) == "02_Simple_Loop.vfx");
        File.Copy(template, "Assets/Curated/TestGraph.vfx");
        AssetDatabase.ImportAsset("Assets/Curated/TestGraph.vfx", ImportAssetOptions.ForceSynchronousImport);
        var vfxType = AppDomain.CurrentDomain.GetAssemblies()
            .Select(assembly => assembly.GetType("UnityEngine.VFX.VisualEffect"))
            .First(type => type != null);
        var vfxObject = new GameObject("SceneVfx");
        var vfx = vfxObject.AddComponent(vfxType);
        vfxType.GetProperty("visualEffectAsset").SetValue(vfx,
            AssetDatabase.LoadMainAssetAtPath("Assets/Curated/TestGraph.vfx"));
        vfxObject.SetActive(false);
        ParticlePackageExporterV2.ExportActiveScene(Path.Combine(output, "vfx-only"),
            new[] { "Assets/Curated/TestGraph.vfx" }, false, true, false);
        var graphs = ReadManifest(Path.Combine(output, "vfx-only"));
        Assert(graphs.exports.Length >= 1 && graphs.exports.Length <= 2 && graphs.exports.All(entry => entry.effectType == "vfx") &&
            graphs.exports.SelectMany(entry => entry.sourcePaths).Count() == 2,
            "VFX-only scan must include inactive scene VFX and selected graph assets without particles or shaders.");
        Assert(!vfxObject.activeSelf, "VFX source state was modified.");

        ParticlePackageExporterV2.ExportActiveScene(Path.Combine(output, "packages"),
            new[] { "Assets/Curated", "Assets/FindFXTestParticle.shader" }, true, true, true);
        var mixed = ReadManifest(Path.Combine(output, "packages"));
        Assert(mixed.exports.Length == 4 + graphs.exports.Length && mixed.exports.Count(entry => entry.effectType == "shader") == 1 &&
            mixed.exports.Count(entry => entry.effectType == "particle") == 3,
            "Mixed scan must preserve effect types while collapsing identical particles.");
        var allDisabledRejected = false;
        try {
            ParticlePackageExporterV2.ExportActiveScene(Path.Combine(output, "disabled"),
                Array.Empty<string>(), false, false, false);
        } catch (InvalidOperationException) { allDisabledRejected = true; }
        Assert(allDisabledRejected, "All scan types disabled must fail explicitly.");

        var invalidRejected = false;
        try {
            ParticlePackageExporterV2.ExportActiveScene(Path.Combine(output, "invalid"),
                new[] { "Assets/Curated/Curated.prefab.meta" });
        } catch (InvalidOperationException) {
            invalidRejected = true;
        }
        Assert(invalidRejected, "Invalid selected assets must produce an explicit error.");
        Assert(!AssetDatabase.IsValidFolder(ParticlePackageExporterV2.GeneratedPrefabFolder),
            "Failure must clean up generated prefabs.");
        EditorSceneManager.CloseScene(otherScene, true);
        EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        var baseline = Particle("Baseline", 1);
        Particle("RenamedDuplicate", 1);
        var rate = Particle("DifferentRate", 1).GetComponent<ParticleSystem>().emission;
        rate.rateOverTime = 37;
        Particle("DifferentScale", 1).transform.localScale = Vector3.one * 2;
        var material = new Material(shader);
        AssetDatabase.CreateAsset(material, "Assets/DifferentParticle.mat");
        Particle("DifferentMaterial", 1).GetComponent<ParticleSystemRenderer>().sharedMaterial = material;
        foreach (var offset in new[] { 1f, 2f })
        {
            var composite = Particle("Composite" + offset, 1);
            var child = Particle("Child", 1);
            child.transform.SetParent(composite.transform);
            child.transform.localPosition = Vector3.up * offset;
        }
        ParticlePackageExporterV2.ExportActiveScene(Path.Combine(output, "dedup"), Array.Empty<string>());
        var dedup = ReadManifest(Path.Combine(output, "dedup"));
        Assert(dedup.exports.Length == 6 && dedup.duplicateCount == 1 &&
            dedup.exports.Select(entry => entry.contentHash).Distinct().Count() == 6,
            "Deduplication must preserve different emission, scale, materials and child transforms.");
        Assert(baseline != null && baseline.name == "Baseline", "Deduplication changed source objects.");
        EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        var emptyRejected = false;
        try {
            ParticlePackageExporterV2.ExportActiveScene(Path.Combine(output, "empty"), Array.Empty<string>());
        } catch (InvalidOperationException) {
            emptyRejected = true;
        }
        Assert(emptyRejected, "An empty active scene must fail explicitly.");
        Debug.Log("FINDFX_TESTS_PASSED: active-scene scope, inactive/nested particles, instance overrides, " +
            "curated deduplication, source preservation, invalid selection and empty scene.");
    }

    private static GameObject Particle(string name, float lifetime)
    {
        var root = new GameObject(name);
        var particle = root.AddComponent<ParticleSystem>();
        var main = particle.main;
        main.startLifetime = lifetime;
        root.GetComponent<ParticleSystemRenderer>().sharedMaterial =
            AssetDatabase.LoadAssetAtPath<Material>("Assets/TestParticle.mat");
        return root;
    }

    private static Manifest ReadManifest(string folder)
    {
        return JsonUtility.FromJson<Manifest>(File.ReadAllText(Path.Combine(folder, "particle-package-manifest.json")));
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }
}

