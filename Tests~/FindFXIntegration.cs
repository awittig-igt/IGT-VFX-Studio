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
        Assert(curated.exports.Length == 4, "Selected folders and prefabs must be deduplicated and narrowly scoped.");
        Assert(curated.exports.Count(entry => entry.sourceKind == "prefab") == 1,
            "Curated scope included unrelated prefab assets.");

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
        Assert(graphs.exports.Length == 2 && graphs.exports.All(entry => entry.effectType == "vfx"),
            "VFX-only scan must include inactive scene VFX and selected graph assets without particles or shaders.");
        Assert(!vfxObject.activeSelf, "VFX source state was modified.");

        ParticlePackageExporterV2.ExportActiveScene(Path.Combine(output, "packages"),
            new[] { "Assets/Curated", "Assets/FindFXTestParticle.shader" }, true, true, true);
        var mixed = ReadManifest(Path.Combine(output, "packages"));
        Assert(mixed.exports.Length == 7 && mixed.exports.Count(entry => entry.effectType == "shader") == 1 &&
            mixed.exports.Count(entry => entry.effectType == "vfx") == 2,
            "Mixed scan must preserve effect types and include four particles, two VFX and one shader.");
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

