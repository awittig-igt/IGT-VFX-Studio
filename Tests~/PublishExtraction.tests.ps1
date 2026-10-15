$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $repo 'Tools~/unity-project-extraction-job.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors) { throw ($parseErrors -join "`n") }
foreach ($name in @('Convert-ToSlug', 'Get-StableEffectId', 'Publish-Extraction')) {
    $definition = $ast.Find({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
}
. (Join-Path $repo 'Tools~/unity-editor-resolver.ps1')
function Assert($condition, $message) { if (-not $condition) { throw $message } }
$root = Join-Path ([IO.Path]::GetTempPath()) ('FindFXPublishExtraction_' + [Guid]::NewGuid().ToString('N'))
$SourceProjectPath = Join-Path $root 'Source'
$OutputPath = Join-Path $root 'Export'
$LocalFolder = Join-Path $root 'Library'
$GameName = 'MyGame'
try {
    New-Item -ItemType Directory -Path (Join-Path $SourceProjectPath 'ProjectSettings'), $OutputPath -Force | Out-Null
    Set-Content (Join-Path $SourceProjectPath 'ProjectSettings/ProjectVersion.txt') 'm_EditorVersion: 2022.3.62f1'
    Set-Content (Join-Path $OutputPath 'fire.unitypackage') 'test package'
    $manifest = [pscustomobject]@{ unityVersion = '2022.3.63f1'; exports = @(
        [pscustomobject]@{ name = 'Fire'; sourcePath = 'Assets/Fire.prefab'; prefabAssetPath = 'Assets/Preview.prefab'; packageFile = 'fire.unitypackage' }
    ) }
    $capture = [pscustomobject]@{ captures = @() }
    Assert ((Publish-Extraction $manifest $capture) -eq 1) 'Effect was not published.'
    $effect = (Get-Content (Join-Path $LocalFolder 'manifest.json') -Raw | ConvertFrom-Json).effects[0]
    Assert ($effect.unityVersion -eq '2022.3.63f1') 'Source exporter version was not retained.'
    Assert ($effect.sourceProjectPath -eq $SourceProjectPath) 'Source project identity was not retained.'
    $manifest.PSObject.Properties.Remove('unityVersion')
    Assert ((Publish-Extraction $manifest $capture) -eq 1) 'Legacy extraction was not published.'
    $effects = @((Get-Content (Join-Path $LocalFolder 'manifest.json') -Raw | ConvertFrom-Json).effects)
    Assert ($effects.Count -eq 1) 'Re-extraction duplicated the effect.'
    Assert ($effects[0].unityVersion -eq '2022.3.62f1') 'Legacy exporter did not use the source project version.'
    Write-Output 'PASS: source version persistence and legacy exporter fallback.'
} finally {
    $resolvedRoot = [IO.Path]::GetFullPath($root)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolvedRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path $resolvedRoot -Leaf) -notlike 'FindFXPublishExtraction_*') { throw 'Unsafe cleanup path.' }
    if (Test-Path -LiteralPath $resolvedRoot) { Remove-Item -LiteralPath $resolvedRoot -Recurse -Force }
}
