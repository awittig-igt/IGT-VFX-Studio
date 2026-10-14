param(
    [Parameter(Mandatory = $true)][string]$ProjectPath,
    [Parameter(Mandatory = $true)][string]$PackagePath,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][string]$StatusPath
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'unity-editor-resolver.ps1')
. (Join-Path $PSScriptRoot 'unity-process.ps1')

function Set-JobStatus {
    param([string]$State, [string]$Phase, [int]$Progress, [string]$Message, [int]$CaptureCount = 0)
    @{
        state        = $State
        phase        = $Phase
        progress     = $Progress
        message      = $Message
        captureCount = $CaptureCount
        updatedAt    = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $StatusPath -Encoding UTF8
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
    Write-Host "Using Unity $($resolution.selectedVersion) ($matchNote): $($resolution.selectedPath)"
    return [string]$resolution.selectedPath
}

$temporaryProject = $null
$workingProjectPath = $ProjectPath

try {
    if (-not (Test-Path -LiteralPath $ProjectPath)) { throw "Unity project not found: $ProjectPath" }
    if (-not (Test-Path -LiteralPath $PackagePath)) { throw "Package not found: $PackagePath" }
    $lockFile = Join-Path $ProjectPath 'Temp\UnityLockfile'
    if (Test-Path -LiteralPath $lockFile) {
        try {
            $lockStream = [IO.File]::Open($lockFile, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            $lockStream.Close()
            Remove-Item -LiteralPath $lockFile -Force
        } catch {
            Set-JobStatus 'running' 'prepare' 12 'Unity project is open. Creating an isolated capture workspace...'
            $temporaryProject = Join-Path $env:TEMP ('EffectsExtractorUnityJob_' + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $temporaryProject -Force | Out-Null
            foreach ($folder in @('Assets', 'Packages', 'ProjectSettings')) {
                $source = Join-Path $ProjectPath $folder
                if (Test-Path -LiteralPath $source) {
                    Copy-Item -LiteralPath $source -Destination (Join-Path $temporaryProject $folder) -Recurse -Force
                }
            }
            $workingProjectPath = $temporaryProject
        }
    }
    if (-not (Test-Path -LiteralPath $OutputPath)) { New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null }

    $unity = Find-UnityEditor $workingProjectPath
    $logDirectory = Split-Path -Parent $StatusPath
    $importLog = Join-Path $logDirectory 'effects-unity-import.log'
    $captureLog = Join-Path $logDirectory 'effects-unity-capture.log'

    Set-JobStatus 'running' 'import' 20 'Starting Unity and importing the package...'
    $importArguments = @(
        '-batchmode', '-quit',
        '-projectPath', ('"{0}"' -f $workingProjectPath),
        '-importPackage', ('"{0}"' -f $PackagePath),
        '-logFile', ('"{0}"' -f $importLog)
    )
    $importProcess = Invoke-UnityEditorProcess -EditorPath $unity -Arguments $importArguments
    if ($importProcess.ExitCode -ne 0) {
        $tail = if (Test-Path $importLog) { (Get-Content $importLog -Tail 15) -join ' ' } else { 'No Unity log was produced.' }
        throw "Unity package import failed (exit $($importProcess.ExitCode)). $tail"
    }

    Set-JobStatus 'running' 'capture' 65 'Package imported. Capturing particle thumbnails...'
    $captureArguments = @(
        '-batchmode', '-quit',
        '-projectPath', ('"{0}"' -f $workingProjectPath),
        '-executeMethod', 'EffectsExtractor.Editor.EffectsThumbnailCapture.CaptureAllFromCommandLine',
        '-captureOutput', ('"{0}"' -f $OutputPath),
        '-logFile', ('"{0}"' -f $captureLog)
    )
    $captureProcess = Invoke-UnityEditorProcess -EditorPath $unity -Arguments $captureArguments
    if ($captureProcess.ExitCode -ne 0) {
        $tail = if (Test-Path $captureLog) { (Get-Content $captureLog -Tail 15) -join ' ' } else { 'No Unity log was produced.' }
        throw "Unity thumbnail capture failed (exit $($captureProcess.ExitCode)). $tail"
    }

    $count = @(Get-ChildItem -LiteralPath $OutputPath -Filter '*.png' -File -ErrorAction SilentlyContinue).Count
    Set-JobStatus 'complete' 'capture' 90 "Unity captured $count thumbnail(s)." $count
} catch {
    Set-JobStatus 'failed' 'error' 100 $_.Exception.Message
    exit 1
} finally {
    if ($temporaryProject -and (Test-Path -LiteralPath $temporaryProject)) {
        $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
        $resolvedTemporary = [IO.Path]::GetFullPath($temporaryProject)
        if ($resolvedTemporary.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
