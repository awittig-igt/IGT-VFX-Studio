param(
    [Parameter(Mandatory = $true)][string]$SourceProjectPath,
    [Parameter(Mandatory = $true)][string]$PreviewProjectPath,
    [Parameter(Mandatory = $true)][string]$AutomationSourcePath,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][string]$CapturePath,
    [Parameter(Mandatory = $true)][string]$LocalFolder,
    [Parameter(Mandatory = $true)][string]$StatusPath,
    [Parameter(Mandatory = $true)][string]$GameName,
    [string]$PreExportedPath = "",
    [int]$ExportLimit = 0,
    [switch]$ExportOnly
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'unity-editor-resolver.ps1')
. (Join-Path $PSScriptRoot 'unity-process.ps1')

function Write-ExtractionLog {
    param([string]$Message)
    $entry = "[{0}] {1}" -f [DateTime]::UtcNow.ToString('o'), $Message
    Write-Host $entry
    if ($diagnosticLogPath) {
        Add-Content -LiteralPath $diagnosticLogPath -Value $entry -Encoding UTF8
    }
}

function Set-JobStatus {
    param(
        [string]$State,
        [string]$Phase,
        [int]$Progress,
        [string]$Message,
        [int]$ExportCount = 0,
        [int]$CaptureCount = 0,
        [int]$LibraryCount = 0,
        [string[]]$Warnings = @()
    )
    $script:currentPhase = $Phase
    Write-ExtractionLog "$State / $Phase ($Progress%): $Message"
    @{
        state        = $State
        phase        = $Phase
        progress     = $Progress
        message      = $Message
        exportCount  = $ExportCount
        captureCount = $CaptureCount
        libraryCount = $LibraryCount
        warnings     = @($Warnings)
        logPath      = $diagnosticLogPath
        updatedAt    = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $StatusPath -Encoding UTF8
}

function Find-UnityEditor {
    param([string]$TargetProjectPath)
    $resolution = Resolve-UnityEditorForProject $TargetProjectPath
    if (-not $resolution.found) {
        throw (@($resolution.reasons) -join ' ')
    }
    $matchNote = if ($resolution.familyExemptionUsed) {
        "family exemption for project $($resolution.projectVersion)"
    } else {
        'exact match'
    }
    Write-ExtractionLog "Using Unity $($resolution.selectedVersion) ($matchNote): $($resolution.selectedPath)"
    return [string]$resolution.selectedPath
}

function Invoke-ExtractionUnity {
    param([string]$EditorPath, [string[]]$Arguments, [string]$LogPath)
    Write-ExtractionLog ("Launching: `"$EditorPath`" " + ($Arguments -join ' '))
    Write-ExtractionLog "Unity log: $LogPath"
    $process = Invoke-UnityEditorProcess -EditorPath $EditorPath -Arguments $Arguments
    Write-ExtractionLog "Unity process $($process.Id) exited with code $($process.ExitCode)."
    return $process
}

function Assert-ProjectAvailable {
    param([string]$TargetProjectPath)
    if (-not (Test-Path -LiteralPath (Join-Path $TargetProjectPath 'Assets') -PathType Container) -or
        -not (Test-Path -LiteralPath (Join-Path $TargetProjectPath 'ProjectSettings') -PathType Container)) {
        throw "Not a valid Unity project: $TargetProjectPath"
    }

    $lockFile = Join-Path $TargetProjectPath 'Temp\UnityLockfile'
    if (-not (Test-Path -LiteralPath $lockFile -PathType Leaf)) { return }
    try {
        $stream = [IO.File]::Open($lockFile, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $stream.Dispose()
        Remove-Item -LiteralPath $lockFile -Force
    } catch {
        throw 'The Unity project is open. Close that Editor before starting project extraction.'
    }
}

function New-PreviewWorkspace {
    param(
        [string]$TemplateProjectPath,
        [string]$WorkspacePath
    )

    if (Test-Path -LiteralPath $WorkspacePath) {
        $resolvedWorkspace = [IO.Path]::GetFullPath($WorkspacePath)
        $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
        if (-not $resolvedWorkspace.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to replace preview workspace outside the temp folder: $resolvedWorkspace"
        }
        Remove-Item -LiteralPath $resolvedWorkspace -Recurse -Force
    }

    New-Item -ItemType Directory -Force -Path (Join-Path $WorkspacePath 'Assets') | Out-Null
    foreach ($folderName in @('Packages', 'ProjectSettings')) {
        $source = Join-Path $TemplateProjectPath $folderName
        if (-not (Test-Path -LiteralPath $source -PathType Container)) {
            throw "Preview template is missing $folderName."
        }
        Copy-Item -LiteralPath $source -Destination (Join-Path $WorkspacePath $folderName) -Recurse -Force
    }

    # Preserve render-pipeline configuration without copying game/sample assets.
    $settingsSource = Join-Path $TemplateProjectPath 'Assets\Settings'
    if (Test-Path -LiteralPath $settingsSource -PathType Container) {
        Copy-Item -LiteralPath $settingsSource -Destination (Join-Path $WorkspacePath 'Assets\Settings') -Recurse -Force
        $settingsMeta = $settingsSource + '.meta'
        if (Test-Path -LiteralPath $settingsMeta -PathType Leaf) {
            Copy-Item -LiteralPath $settingsMeta -Destination (Join-Path $WorkspacePath 'Assets\Settings.meta') -Force
        }
    }

    return [IO.Path]::GetFullPath($WorkspacePath)
}

function Convert-ToSlug {
    param([string]$Value)
    $slug = ($Value.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
    if ($slug) { return $slug }
    return 'effect'
}

function Get-StableEffectId {
    param([string]$ProjectName, [string]$AssetPath, [string]$DisplayName)
    $bytes = [Text.Encoding]::UTF8.GetBytes($ProjectName + ':' + $AssetPath)
    $hashBytes = [Security.Cryptography.SHA1]::Create().ComputeHash($bytes)
    $hash = -join ($hashBytes[0..3] | ForEach-Object { $_.ToString('x2') })
    return "$(Convert-ToSlug $DisplayName)-$(Convert-ToSlug $ProjectName)-$hash"
}

function Add-AutomationScript {
    param(
        [string]$FileName,
        [string]$TargetAssetsPath,
        [string]$InjectionPath,
        [System.Collections.Generic.List[string]]$InjectedFiles
    )
    $source = Join-Path $AutomationSourcePath $FileName
    if ($FileName -eq 'ParticlePackageExporterV2.cs' -and
        -not (Test-Path -LiteralPath $source -PathType Leaf)) {
        $source = Join-Path $PSScriptRoot 'packages\com.igt.findfx\Editor\ParticlePackageExporterV2.cs'
    }
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Automation script not found: $source"
    }
    if (-not (Test-Path -LiteralPath $InjectionPath -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $InjectionPath | Out-Null
    }
    $destination = Join-Path $InjectionPath $FileName
    $conflict = Get-ChildItem -LiteralPath $TargetAssetsPath -Filter $FileName -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { [IO.Path]::GetFullPath($_.FullName) -ne [IO.Path]::GetFullPath($destination) } |
        Select-Object -First 1
    if ($conflict) {
        throw "A conflicting Effects Extractor automation script already exists: $($conflict.FullName)"
    }
    Copy-Item -LiteralPath $source -Destination $destination -Force
    $InjectedFiles.Add($destination)
}

function Remove-LegacyInjectedScript {
    param(
        [string]$InjectionPath,
        [string]$FileName
    )
    $legacyPath = Join-Path $InjectionPath $FileName
    if (Test-Path -LiteralPath $legacyPath -PathType Leaf) {
        Remove-Item -LiteralPath $legacyPath -Force
    }
    if (Test-Path -LiteralPath ($legacyPath + '.meta') -PathType Leaf) {
        Remove-Item -LiteralPath ($legacyPath + '.meta') -Force
    }
}

function Get-LogTail {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 'No Unity log was produced.' }
    return (Get-Content -LiteralPath $Path -Tail 20) -join [Environment]::NewLine
}

function Publish-Extraction {
    param([object]$ExportManifest, [object]$CaptureManifest)

    $packagesFolder = Join-Path $LocalFolder 'packages'
    $thumbnailsFolder = Join-Path $LocalFolder 'thumbnails'
    New-Item -ItemType Directory -Force -Path $packagesFolder | Out-Null
    New-Item -ItemType Directory -Force -Path $thumbnailsFolder | Out-Null

    $libraryManifestPath = Join-Path $LocalFolder 'manifest.json'
    if (Test-Path -LiteralPath $libraryManifestPath -PathType Leaf) {
        $libraryManifest = Get-Content -LiteralPath $libraryManifestPath -Raw | ConvertFrom-Json
    } else {
        $libraryManifest = [pscustomobject]@{
            version = '1.0.0'
            generatedAt = [DateTime]::UtcNow.ToString('o')
            effects = @()
        }
    }
    $effects = @($libraryManifest.effects)

    $capturesByPath = @{}
    foreach ($capture in @($CaptureManifest.captures)) {
        if ($capture.assetPath) { $capturesByPath[$capture.assetPath] = $capture }
    }

    $published = 0
    foreach ($export in @($ExportManifest.exports)) {
        $captureAssetPath = if ($export.captureAssetPath) {
            [string]$export.captureAssetPath
        } else {
            [string]$export.prefabAssetPath
        }
        $sourceAssetPath = if ($export.sourcePath) {
            [string]$export.sourcePath
        } else {
            [string]$export.sourcePrefabAssetPath
        }
        $effectType = if ($export.effectType) { [string]$export.effectType } else { 'particle' }
        $identityPath = if ($effectType -eq 'particle') { $sourceAssetPath } else { $sourceAssetPath + '::' + $effectType }
        $id = Get-StableEffectId $GameName $identityPath $export.name
        $packageSource = Join-Path $OutputPath $export.packageFile
        if (-not (Test-Path -LiteralPath $packageSource -PathType Leaf)) {
            throw "Exported package is missing: $packageSource"
        }

        $packageName = "$id.unitypackage"
        Copy-Item -LiteralPath $packageSource -Destination (Join-Path $packagesFolder $packageName) -Force
        $capture = $capturesByPath[$captureAssetPath]
        $thumbnailRelative = $null
        if ($capture -and $capture.thumbnail) {
            $captureSource = Join-Path $CapturePath $capture.thumbnail
            if (Test-Path -LiteralPath $captureSource -PathType Leaf) {
                $thumbnailName = "$id.png"
                Copy-Item -LiteralPath $captureSource -Destination (Join-Path $thumbnailsFolder $thumbnailName) -Force
                $thumbnailRelative = "thumbnails/$thumbnailName"
            }
        }

        $metadata = [ordered]@{
            particleSystemCount = [int]$export.particleSystemCount
            dependencyCount = [int]$export.dependencyCount
            missingScriptCount = [int]$export.missingScriptCount
            removedScriptCount = [int]$export.removedScriptCount
            removedComponentCount = [int]$export.removedComponentCount
            removedGameObjectCount = [int]$export.removedGameObjectCount
            sanitized = [bool]$export.sanitized
            sourceKind = $export.sourceKind
            sourceHierarchy = $export.sourceHierarchy
        }
        if ($capture -and $capture.metadata) {
            foreach ($property in $capture.metadata.PSObject.Properties) {
                $metadata[$property.Name] = $property.Value
            }
        }

        $entry = [pscustomobject]@{
            id = $id
            name = $export.name
            type = $effectType
            game = $GameName
            importSource = 'project-scan'
            packageFile = $packageName
            originalPath = $sourceAssetPath
            files = [pscustomobject]@{
                main = $null
                package = "packages/$packageName"
                thumbnail = $thumbnailRelative
            }
            metadata = [pscustomobject]$metadata
            tags = @($effectType, (Convert-ToSlug $GameName), 'project-scan', 'unity-package')
            extractedAt = [DateTime]::UtcNow.ToString('o')
        }
        $effects = @($effects | Where-Object { $_.id -ne $id })
        $effects += $entry
        $published++
    }

    $libraryManifest.effects = @($effects | Sort-Object name, id)
    $libraryManifest.generatedAt = [DateTime]::UtcNow.ToString('o')
    $json = $libraryManifest | ConvertTo-Json -Depth 30
    $temporaryManifest = $libraryManifestPath + '.tmp'
    [IO.File]::WriteAllText($temporaryManifest, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryManifest -Destination $libraryManifestPath -Force
    return $published
}

$sourceInjectedFiles = [System.Collections.Generic.List[string]]::new()
$previewInjectedFiles = [System.Collections.Generic.List[string]]::new()
$sourceInjectionPath = $null
$previewInjectionPath = $null
$previewWorkspace = $null
$jobRoot = $null
$diagnosticLogPath = $null
$currentPhase = 'prepare'

try {
    $jobRoot = Split-Path -Parent ([IO.Path]::GetFullPath($OutputPath))
    New-Item -ItemType Directory -Force -Path $jobRoot | Out-Null
    $diagnosticLogPath = Join-Path $jobRoot 'extraction.log'
    Write-ExtractionLog "Starting extraction for '$GameName'."
    Write-ExtractionLog "Source: $SourceProjectPath"
    Write-ExtractionLog "Preview template: $PreviewProjectPath"
    Write-ExtractionLog "Packages: $OutputPath; captures: $CapturePath; library: $LocalFolder"
    $SourceProjectPath = [IO.Path]::GetFullPath($SourceProjectPath)
    $PreviewProjectPath = [IO.Path]::GetFullPath($PreviewProjectPath)
    $OutputPath = [IO.Path]::GetFullPath($OutputPath)
    $CapturePath = [IO.Path]::GetFullPath($CapturePath)
    $LocalFolder = [IO.Path]::GetFullPath($LocalFolder)
    if (-not $PreExportedPath) { Assert-ProjectAvailable $SourceProjectPath }
    Assert-ProjectAvailable $PreviewProjectPath
    New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null
    New-Item -ItemType Directory -Force -Path $CapturePath | Out-Null
    New-Item -ItemType Directory -Force -Path $LocalFolder | Out-Null
    $jobRoot = Split-Path -Parent $OutputPath

    Set-JobStatus 'running' 'prepare' 10 'Preparing the game scanner and preview container...'
    $sourceAssetsPath = Join-Path $SourceProjectPath 'Assets'
    $sourceInjectionPath = Join-Path $sourceAssetsPath 'Editor\EffectsExtractorPhase2'
    if (-not $PreExportedPath) {
        Remove-LegacyInjectedScript $sourceInjectionPath 'ParticlePackageExporter.cs'
        Add-AutomationScript 'ParticlePackageExporterV2.cs' $sourceAssetsPath $sourceInjectionPath $sourceInjectedFiles
    }

    if (-not $ExportOnly) {
        $workspacePath = Join-Path $env:TEMP ('FXP_' + [Guid]::NewGuid().ToString('N').Substring(0, 12))
        if (Test-Path -LiteralPath $workspacePath) {
            throw "Preview workspace already exists: $workspacePath"
        }
        $previewWorkspace = New-PreviewWorkspace -TemplateProjectPath $PreviewProjectPath -WorkspacePath $workspacePath
        Write-ExtractionLog "Disposable preview workspace: $previewWorkspace"
    }
    $previewAssetsPath = if ($ExportOnly) {
        Join-Path $PreviewProjectPath 'Assets'
    } else {
        Join-Path $previewWorkspace 'Assets'
    }
    $previewInjectionPath = Join-Path $previewAssetsPath 'Editor\EffectsExtractorPhase2'
    if (-not $ExportOnly) {
        Add-AutomationScript 'EffectsThumbnailCaptureV2.cs' $previewAssetsPath $previewInjectionPath $previewInjectedFiles
    }

    $sourceUnity = if ($PreExportedPath) { $null } else { Find-UnityEditor $SourceProjectPath }
    $previewUnity = if ($ExportOnly) { $null } else { Find-UnityEditor $PreviewProjectPath }
    $logFolder = $jobRoot
    $exportLog = Join-Path $logFolder 'effects-project-export.log'
    $importLog = Join-Path $logFolder 'effects-preview-import.log'
    $captureLog = Join-Path $logFolder 'effects-project-capture.log'
    $exportManifestPath = Join-Path $OutputPath 'particle-package-manifest.json'

    if ($PreExportedPath) {
        Set-JobStatus 'running' 'export' 25 'Using effects extracted by FindFX from the open Unity Editor...'
        $PreExportedPath = [IO.Path]::GetFullPath($PreExportedPath)
        if (-not (Test-Path -LiteralPath (Join-Path $PreExportedPath 'particle-package-manifest.json') -PathType Leaf)) {
            throw "FindFX export manifest not found in: $PreExportedPath"
        }
        Copy-Item -Path (Join-Path $PreExportedPath '*') -Destination $OutputPath -Recurse -Force
    } else {
        Set-JobStatus 'running' 'export' 25 'Finding particles in scenes and prefabs, then exporting safe dependencies...'
        $exportArguments = @(
            '-batchmode', '-quit', '-nographics', '-accept-apiupdate',
            '-projectPath', ('"{0}"' -f $SourceProjectPath),
            '-executeMethod', 'EffectsExtractor.Editor.ParticlePackageExporterV2.ExportProjectFromCommandLine',
            '-particlePackageOutput', ('"{0}"' -f $OutputPath),
            '-logFile', ('"{0}"' -f $exportLog)
        )
        if ($ExportLimit -gt 0) {
            $exportArguments += @('-particleExportLimit', [string]$ExportLimit)
        }
        $exportProcess = Invoke-ExtractionUnity $sourceUnity $exportArguments $exportLog
        if ($exportProcess.ExitCode -ne 0) {
            throw "Unity prefab export failed (exit $($exportProcess.ExitCode)). $(Get-LogTail $exportLog)"
        }
        if (-not (Test-Path -LiteralPath $exportManifestPath -PathType Leaf)) {
            throw 'Unity completed without creating an effect package manifest.'
        }
    }
    $exportManifest = Get-Content -LiteralPath $exportManifestPath -Raw | ConvertFrom-Json
    $exportCount = @($exportManifest.exports).Count
    if ($exportCount -eq 0) { throw 'No effects were found in the Unity project.' }
    if ([int]$exportManifest.formatVersion -lt 2 -or $exportManifest.sanitized -ne $true) {
        throw 'The exporter did not produce a sanitized effect manifest.'
    }
    foreach ($export in @($exportManifest.exports)) {
        $captureAssetPath = if ($export.captureAssetPath) {
            [string]$export.captureAssetPath
        } else {
            [string]$export.prefabAssetPath
        }
        if ($export.effectType -and $export.effectType -notin @('particle', 'vfx', 'shader')) {
            throw "Unsupported effect type: $($export.effectType)"
        }
        if ($export.sanitized -ne $true -or
            -not $captureAssetPath.StartsWith('Assets/EffectsExtractor/ParticlePackages/', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Unsafe export entry was blocked: $($export.name)"
        }
        if ($captureAssetPath -eq [string]$export.sourcePath) {
            throw "Source prefab was exported directly instead of being sanitized: $($export.sourcePath)"
        }
        foreach ($dependency in @($export.dependencies)) {
            $extension = [IO.Path]::GetExtension([string]$dependency)
            if ($extension -in @('.cs', '.dll', '.asmdef', '.asmref', '.unity')) {
                throw "Unsafe dependency was blocked before preview import: $dependency"
            }
            if ($extension -eq '.prefab' -and [string]$dependency -ne $captureAssetPath) {
                throw "Nested or source prefab dependency was blocked before preview import: $dependency"
            }
        }
    }

    if (-not $exportManifest.previewPackageFile) {
        throw 'The game project export did not create the preview import package.'
    }
    $previewPackagePath = Join-Path $OutputPath $exportManifest.previewPackageFile
    if (-not (Test-Path -LiteralPath $previewPackagePath -PathType Leaf)) {
        throw "Preview import package is missing: $previewPackagePath"
    }
    if ($ExportOnly) {
        Set-JobStatus 'complete' 'complete' 100 "Validated $exportCount sanitized effect package(s)." $exportCount
        return
    }

    Set-JobStatus 'running' 'import' 50 "Exported $exportCount package(s). Importing assets into the preview container..." $exportCount
    $importArguments = @(
        '-batchmode', '-quit', '-accept-apiupdate',
        '-projectPath', ('"{0}"' -f $previewWorkspace),
        '-importPackage', ('"{0}"' -f $previewPackagePath),
        '-logFile', ('"{0}"' -f $importLog)
    )
    $importProcess = Invoke-ExtractionUnity $previewUnity $importArguments $importLog
    if ($importProcess.ExitCode -ne 0) {
        throw "Unity preview import failed (exit $($importProcess.ExitCode)). $(Get-LogTail $importLog)"
    }

    Set-JobStatus 'running' 'capture' 70 'Assets imported into the preview container. Capturing effect previews...' $exportCount
    $captureArguments = @(
        '-batchmode', '-accept-apiupdate',
        '-projectPath', ('"{0}"' -f $previewWorkspace),
        '-executeMethod', 'EffectsExtractor.Editor.EffectsThumbnailCaptureV2.CaptureAllFromCommandLine',
        '-captureOutput', ('"{0}"' -f $CapturePath),
        '-captureSelectionManifest', ('"{0}"' -f $exportManifestPath),
        '-logFile', ('"{0}"' -f $captureLog)
    )
    $captureProcess = Invoke-ExtractionUnity $previewUnity $captureArguments $captureLog
    if ($captureProcess.ExitCode -ne 0) {
        throw "Unity preview capture failed (exit $($captureProcess.ExitCode)). $(Get-LogTail $captureLog)"
    }
    $captureManifestPath = Join-Path $CapturePath 'capture-manifest.json'
    if (-not (Test-Path -LiteralPath $captureManifestPath -PathType Leaf)) {
        throw 'Unity completed without creating a capture manifest.'
    }
    $captureManifest = Get-Content -LiteralPath $captureManifestPath -Raw | ConvertFrom-Json
    $captureCount = @($captureManifest.captures).Count
    if ($captureCount -ne $exportCount) {
        throw "Preview capture count ($captureCount) did not match sanitized export count ($exportCount)."
    }

    Set-JobStatus 'running' 'publish' 85 "Captured $captureCount preview(s). Publishing to the library..." $exportCount $captureCount
    $published = Publish-Extraction $exportManifest $captureManifest
    $warnings = @($exportManifest.warnings)
    foreach ($warning in $warnings) { Write-ExtractionLog "WARNING: $warning" }
    Set-JobStatus 'complete' 'complete' 100 "Published $published effect package(s) to the gallery." $exportCount $captureCount $published $warnings
} catch {
    $failure = $_
    $failedPhase = $currentPhase
    Write-ExtractionLog ("ERROR during ${failedPhase}: " + $failure.Exception.ToString())
    Write-ExtractionLog ("Error ID: " + $failure.FullyQualifiedErrorId)
    Write-ExtractionLog ("Location: " + $failure.InvocationInfo.PositionMessage)
    Write-ExtractionLog ("PowerShell stack: " + $failure.ScriptStackTrace)
    Set-JobStatus 'failed' 'error' 100 "Failed during ${failedPhase}: $($failure.Exception.Message)"
    exit 1
} finally {
    foreach ($file in @($sourceInjectedFiles) + @($previewInjectedFiles)) {
        if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath ($file + '.meta') -PathType Leaf) { Remove-Item -LiteralPath ($file + '.meta') -Force -ErrorAction SilentlyContinue }
    }
    foreach ($injectionPath in @($sourceInjectionPath, $previewInjectionPath)) {
        if ($injectionPath -and (Test-Path -LiteralPath $injectionPath -PathType Container)) {
            if (@(Get-ChildItem -LiteralPath $injectionPath -Force).Count -eq 0) {
                Remove-Item -LiteralPath $injectionPath -Force -ErrorAction SilentlyContinue
                if (Test-Path -LiteralPath ($injectionPath + '.meta') -PathType Leaf) {
                    Remove-Item -LiteralPath ($injectionPath + '.meta') -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }
    if ($previewWorkspace -and (Test-Path -LiteralPath $previewWorkspace -PathType Container)) {
        $resolvedWorkspace = [IO.Path]::GetFullPath($previewWorkspace)
        $resolvedTempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
        if ($resolvedWorkspace.StartsWith($resolvedTempRoot + '\', [StringComparison]::OrdinalIgnoreCase) -and
            [IO.Path]::GetFileName($resolvedWorkspace) -match '^FXP_[a-f0-9]{12}$') {
            Remove-Item -LiteralPath $resolvedWorkspace -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
