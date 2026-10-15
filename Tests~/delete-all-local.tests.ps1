$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'Tools~/serve.ps1'), [ref]$tokens, [ref]$parseErrors)
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Clear-LocalEffectLibrary' }, $true)
. ([scriptblock]::Create($function.Extent.Text))
function Assert($condition, $message) { if (-not $condition) { throw $message } }
$root = Join-Path $repo ('outputs/delete-all-local-test-' + [Guid]::NewGuid().ToString('N'))
$library = Join-Path $root 'library'
New-Item -ItemType Directory -Force -Path (Join-Path $library 'packages'), (Join-Path $library 'thumbnails') | Out-Null
foreach ($relative in @('packages/one.unitypackage', 'packages/orphan.unitypackage', 'thumbnails/current.gif', 'thumbnails/old.gif', 'source.prefab', 'keep.txt')) {
    [IO.File]::WriteAllText((Join-Path $library $relative), 'test fixture')
}
$outside = Join-Path $root 'original.prefab'
[IO.File]::WriteAllText($outside, 'original project fixture')
$manifestPath = Join-Path $library 'manifest.json'
@{ generatedAt = 'before'; effects = @(@{ id = 'one'; files = @{ package = 'packages/one.unitypackage'; thumbnail = 'thumbnails/current.gif'; main = '../original.prefab' } }) } | ConvertTo-Json -Depth 10 | Set-Content $manifestPath
$blocked = $false
try { Clear-LocalEffectLibrary $library } catch { $blocked = $true }
Assert $blocked 'Paths outside the local library must be rejected.'
Assert (Test-Path (Join-Path $library 'packages/one.unitypackage')) 'Validation failure deleted a package.'
Assert (Test-Path $outside) 'Original file was removed.'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$manifest.effects[0].files.main = 'source.prefab'
$manifest | ConvertTo-Json -Depth 10 | Set-Content $manifestPath
$result = Clear-LocalEffectLibrary $library
Assert ($result.deleted -eq 1 -and $result.removedFiles -eq 5) 'Wrong effect/file deletion counts.'
Assert (Test-Path $outside) 'Original file was changed.'
Assert (Test-Path (Join-Path $library 'keep.txt')) 'Unrelated library file was removed.'
Assert (@((Get-Content $manifestPath -Raw | ConvertFrom-Json).effects).Count -eq 0) 'Library was not cleared.'
Assert (@(Get-ChildItem (Join-Path $library 'packages') -File).Count -eq 0) 'Orphan package was not removed.'
Assert (@(Get-ChildItem (Join-Path $library 'thumbnails') -File).Count -eq 0) 'Old previews were not removed.'
Write-Host 'PASS: clears library packages/previews, preserves unrelated/original files, rejects paths outside the library before deleting.'
