$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'Tools~/unity-project-extraction-job.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw $parseErrors[0] }
$branches = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Clauses[0].Item1.Extent.Text -eq '$RegenerateEffectId' }, $true))
function Set-JobStatus { }
function Assert($condition, $message) { if (-not $condition) { throw $message } }
$root = Join-Path $repo ('outputs/preview-regeneration-test-' + [Guid]::NewGuid().ToString('N'))
$LocalFolder = Join-Path $root 'library'
$OutputPath = Join-Path $root 'packages'
$CapturePath = Join-Path $root 'captures'
New-Item -ItemType Directory -Force -Path $LocalFolder, $OutputPath, $CapturePath | Out-Null
$RegenerateEffectId = 'test-particle'
$archiveRoot = Join-Path $root 'archive'
$guid = '0123456789abcdef0123456789abcdef'
New-Item -ItemType Directory -Force -Path (Join-Path $archiveRoot $guid) | Out-Null
[IO.File]::WriteAllText((Join-Path $archiveRoot "$guid/pathname"), 'Assets/EffectsExtractor/ParticlePackages/Test.prefab')
[IO.File]::WriteAllText((Join-Path $archiveRoot "$guid/asset"), 'fixture')
$package = Join-Path $LocalFolder 'original.unitypackage'
& tar.exe -czf $package -C $archiveRoot $guid
if ($LASTEXITCODE) { throw 'Could not create test package.' }
$originalHash = (Get-FileHash -LiteralPath $package).Hash
$effect = @{ id = $RegenerateEffectId; name = 'Test'; type = 'particle'; originalPath = 'Assets/Test.prefab'; metadata = @{ rateOverTime = 0 }; files = @{ package = 'original.unitypackage'; thumbnail = 'old.gif' } }
@{ effects = @($effect, @{ id = 'other'; name = 'Unrelated' }); generatedAt = 'before' } | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $LocalFolder 'manifest.json')
$exportManifestPath = Join-Path $OutputPath 'particle-package-manifest.json'
$prepare = $branches | Where-Object { $_.Extent.Text.Contains('$entries = @(& tar.exe') } | Select-Object -First 1
Assert ($null -ne $prepare) 'Preparation branch not found.'
. ([scriptblock]::Create($prepare.Clauses[0].Item2.Extent.Text.Trim().Substring(1).TrimEnd().TrimEnd('}')))
$manifest = Get-Content $exportManifestPath -Raw | ConvertFrom-Json
Assert ($manifest.exports.Count -eq 1) 'Must capture exactly one effect.'
Assert ($manifest.exports[0].captureAssetPath -eq 'Assets/EffectsExtractor/ParticlePackages/Test.prefab') 'Wrong capture prefab.'
[IO.File]::WriteAllText((Join-Path $CapturePath 'test.gif'), 'GIF89a-test')
$captureManifest = @{ captures = @(@{ thumbnail = 'test.gif' }) }
$publish = $branches | Where-Object { $_.Extent.Text.Contains('$thumbnailName = $RegenerateEffectId') } | Select-Object -First 1
. ([scriptblock]::Create($publish.Clauses[0].Item2.Extent.Text.Trim().Substring(1).TrimEnd().TrimEnd('}')))
$library = Get-Content (Join-Path $LocalFolder 'manifest.json') -Raw | ConvertFrom-Json
$updated = $library.effects | Where-Object id -eq $RegenerateEffectId
Assert ($updated.files.thumbnail -like 'thumbnails/test-particle-*.gif') 'Preview URL must change to defeat stale caches.'
Assert (Test-Path (Join-Path $LocalFolder $updated.files.thumbnail)) 'New GIF must exist.'
Assert ($updated.metadata.rateOverTime -eq 0) 'Original metadata was changed.'
Assert ($library.effects.Count -eq 2) 'Unrelated effects were changed.'
Assert ((Get-FileHash -LiteralPath $package).Hash -eq $originalHash) 'Original package was changed.'
Write-Host 'PASS: single-effect capture selection, new GIF URL, package and metadata preservation.'
