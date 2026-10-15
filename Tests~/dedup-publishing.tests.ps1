$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $repo 'Tools~\unity-project-extraction-job.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Worker syntax errors.' }
foreach ($name in @('Convert-ToSlug', 'Get-StableEffectId', 'Publish-Extraction')) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([ScriptBlock]::Create($definition.Extent.Text))
}
$testRoot = Join-Path $repo ('outputs\dedup-publishing-' + [Guid]::NewGuid().ToString('N'))
$LocalFolder = Join-Path $testRoot 'library'
$OutputPath = Join-Path $testRoot 'packages'
$CapturePath = Join-Path $testRoot 'captures'
$SourceProjectPath = 'C:\test\source-project'
$GameName = 'TestGame'
New-Item -ItemType Directory -Force -Path $LocalFolder, $OutputPath, $CapturePath | Out-Null
$old = @(
    @{ id = 'old-copy-a'; originalPath = 'scene::A'; sourceProjectPath = $SourceProjectPath },
    @{ id = 'old-copy-b'; originalPath = 'scene::B'; sourceProjectPath = $SourceProjectPath },
    @{ id = 'outside-scope'; originalPath = 'scene::Unselected'; sourceProjectPath = $SourceProjectPath },
    @{ id = 'other-project'; originalPath = 'scene::A'; sourceProjectPath = 'C:\test\other-project' }
)
foreach ($entry in $old) { $entry.name = $entry.id; $entry.type = 'particle'; $entry.importSource = 'project-scan' }
@{ version = '1.0.0'; generatedAt = ''; effects = $old } | ConvertTo-Json -Depth 8 |
    Set-Content -LiteralPath (Join-Path $LocalFolder 'manifest.json') -Encoding UTF8
[IO.File]::WriteAllText((Join-Path $OutputPath 'unique.unitypackage'), 'test-package')
[IO.File]::WriteAllText((Join-Path $CapturePath 'unique.gif'), 'GIF89a-test')
$exports = [pscustomobject]@{ unityVersion = '6000.3.15f1'; exports = @([pscustomobject]@{
    name = 'Unique'; effectType = 'particle'; sourceKind = 'scene'; sourcePath = 'scene::A'; sourceHierarchy = 'A'
    sourcePaths = @('scene::A', 'scene::B'); sourceNames = @('A', 'B'); instanceCount = 2; contentHash = 'test-content-hash'
    captureAssetPath = 'Assets/EffectsExtractor/ParticlePackages/unique.prefab'; packageFile = 'unique.unitypackage'; sanitized = $true
}) }
$captures = [pscustomobject]@{ captures = @([pscustomobject]@{
    assetPath = 'Assets/EffectsExtractor/ParticlePackages/unique.prefab'; thumbnail = 'unique.gif'
}) }
foreach ($attempt in 1..2) {
    $count = Publish-Extraction $exports $captures
    $result = Get-Content -LiteralPath (Join-Path $LocalFolder 'manifest.json') -Raw | ConvertFrom-Json
    if ($count -ne 1 -or @($result.effects).Count -ne 3) { throw 'Duplicate rows were not replaced idempotently.' }
    if (@($result.effects | Where-Object id -in @('outside-scope', 'other-project')).Count -ne 2) { throw 'Unrelated library rows were modified.' }
    $unique = @($result.effects | Where-Object name -eq Unique)[0]
    if ($unique.metadata.instanceCount -ne 2 -or @($unique.metadata.sourcePaths).Count -ne 2) { throw 'Source provenance was lost.' }
    if (-not (Test-Path -LiteralPath (Join-Path $LocalFolder $unique.files.thumbnail))) { throw 'Published GIF missing.' }
}
Write-Host 'PASS: Duplicate gallery migration, provenance, repeat publishing and unrelated project preservation.'
