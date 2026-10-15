param(
    [ValidateRange(1024, 65535)][int]$Port = 18089,
    [string]$PreviewProjectPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'Tools~\BlankEffectsProject')
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'Tools~\unity-editor-resolver.ps1')
. (Join-Path $repo 'Tools~\unity-process.ps1')
$root = Join-Path $env:TEMP ('FindFXIntegration_' + [Guid]::NewGuid().ToString('N'))
$source = Join-Path $root 'source'
$exports = Join-Path $root 'exports'
$server = $null
$worker = $null
$sourceLock = $null
$passed = $false
try {
    $archive = & (Join-Path $repo 'build-package.ps1') -OutputDirectory (Join-Path $root 'dist')
    $entries = & tar.exe -tzf $archive
    if ($LASTEXITCODE -ne 0 -or $entries -notcontains 'package/Tools~/webapp/index.html' -or
        $entries -notcontains 'package/Tools~/BlankEffectsProject/ProjectSettings/ProjectVersion.txt') {
        throw 'Standalone package is missing required runtime files.'
    }
    if (@($entries | Where-Object { $_ -match '/(Library|Temp|UserSettings|\.git)/|\.effects-extractor-config\.json' }).Count) {
        throw 'Standalone package contains runtime state or project caches.'
    }
    New-Item -ItemType Directory -Path (Join-Path $source 'Assets\Editor'), (Join-Path $source 'Packages'),
        (Join-Path $source 'ProjectSettings') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PreviewProjectPath 'ProjectSettings\ProjectVersion.txt') `
        -Destination (Join-Path $source 'ProjectSettings')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'FindFXIntegration.cs') -Destination (Join-Path $source 'Assets\Editor')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'ConnectionCancellation.cs') -Destination (Join-Path $source 'Assets\Editor')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'FindFXTestParticle.shader') -Destination (Join-Path $source 'Assets')
    $manifestJson = @{
        dependencies = @{
            'com.viewfx.editor' = 'file:' + $archive.Replace('\', '/')
            'com.unity.visualeffectgraph' = '17.3.0'
            'com.unity.render-pipelines.universal' = '17.3.0'
            'com.unity.modules.particlesystem' = '1.0.0'
            'com.unity.modules.imgui' = '1.0.0'
            'com.unity.modules.unitywebrequest' = '1.0.0'
            'com.unity.modules.jsonserialize' = '1.0.0'
        }
    } | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText((Join-Path $source 'Packages\manifest.json'), $manifestJson, [Text.UTF8Encoding]::new($false))
    $editor = Resolve-UnityEditorForProject $source
    if (-not $editor.found) { throw ($editor.reasons -join ' ') }
    $env:FINDFX_TEST_OUTPUT = $exports
    $log = Join-Path $root 'source.log'
    $process = Invoke-UnityEditorProcess -EditorPath $editor.selectedPath -Arguments @(
        '-batchmode', '-quit', '-nographics', '-projectPath', ('"{0}"' -f $source),
        '-executeMethod', 'FindFXIntegration.Run', '-logFile', ('"{0}"' -f $log)
    )
    for ($attempt = 1; $attempt -le 3 -and $process.ExitCode -ne 0 -and
        (Select-String -LiteralPath $log -Pattern 'EPERM.*rename' -Quiet); $attempt++) {
        $process.Dispose()
        Copy-Item -LiteralPath $log -Destination "$log.attempt$attempt.log"
        Start-Sleep -Seconds ([Math]::Pow(2, $attempt))
        $process = Invoke-UnityEditorProcess -EditorPath $editor.selectedPath -Arguments @(
            '-batchmode', '-quit', '-nographics', '-projectPath', ('"{0}"' -f $source),
            '-executeMethod', 'FindFXIntegration.Run', '-logFile', ('"{0}"' -f $log)
        )
    }
    if ($process.ExitCode -ne 0 -or -not (Select-String -LiteralPath $log -Pattern 'FINDFX_TESTS_PASSED' -Quiet)) {
        throw "Unity FindFX tests failed (exit $($process.ExitCode)). See $log"
    }
    Write-Host 'PASS: Unity package compilation and active-scene/curated extraction.'
    $process.Dispose()
    $cancelLog = Join-Path $root 'cancellation.log'
    $process = Invoke-UnityEditorProcess -EditorPath $editor.selectedPath -Arguments @(
        '-batchmode', '-nographics', '-projectPath', ('"{0}"' -f $source),
        '-executeMethod', 'ConnectionCancellation.Run', '-logFile', ('"{0}"' -f $cancelLog)
    )
    if ($process.ExitCode -ne 0 -or -not (Select-String -LiteralPath $cancelLog -Pattern 'CANCELLATION_TEST_PASSED' -Quiet)) {
        throw "Connection cancellation tests failed (exit $($process.ExitCode)). See $cancelLog"
    }
    $process.Dispose()
    Write-Host 'PASS: Interrupted connection polling, cancellation failure and retry.'
    $unpacked = Join-Path $root 'unpacked'
    New-Item -ItemType Directory -Path $unpacked | Out-Null
    & tar.exe -xzf $archive -C $unpacked
    if ($LASTEXITCODE -ne 0) { throw 'Could not unpack FindFX runtime.' }
    New-Item -ItemType Directory -Path (Join-Path $source 'Temp') -Force | Out-Null
    $sourceLock = [IO.File]::Open((Join-Path $source 'Temp\UnityLockfile'),
        [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $library = Join-Path $root 'library'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'Tools~\start-findfx.ps1') `
        -RuntimePath (Join-Path $unpacked 'package\Tools~') -SourceProjectPath $source `
        -PreExportedPath (Join-Path $exports 'packages') -LocalFolder $library -Port $Port -NoBrowser
    if ($LASTEXITCODE -ne 0) { throw 'Automatic FindFX server launch failed.' }
    $config = Invoke-RestMethod "http://localhost:$Port/api/config"
    if (-not $config.capabilities.findFX -or -not $config.capabilities.multiEffectPackages -or
        -not $config.capabilities.packageCacheRecovery) {
        throw 'Server did not advertise effect package support and package-cache recovery.'
    }
    # The launcher logs the server PID so cleanup only stops this test's own process.
    $serverPidPath = Join-Path $exports 'server.pid'
    $server = Get-Process -Id ([int](Get-Content -LiteralPath $serverPidPath -Raw))
    $worker = Get-Process -Id ([int](Get-Content -LiteralPath (Join-Path $exports 'worker.pid') -Raw))
    $deadline = [DateTime]::UtcNow.AddMinutes(15)
    do {
        Start-Sleep -Seconds 2
        $status = Invoke-RestMethod "http://localhost:$Port/api/project-extraction-job"
    } while ($status.state -in @('queued', 'running') -and [DateTime]::UtcNow -lt $deadline)
    $expectedCount = @((Get-Content -LiteralPath (Join-Path $exports 'packages\particle-package-manifest.json') -Raw | ConvertFrom-Json).exports).Count
    if ($status.state -ne 'complete' -or $status.exportCount -ne $expectedCount -or $status.captureCount -ne $expectedCount -or
        $status.libraryCount -ne $expectedCount) {
        throw "FindFX preview/publish failed: $($status | ConvertTo-Json -Depth 8)"
    }
    $manifest = Get-Content -LiteralPath (Join-Path $library 'manifest.json') -Raw | ConvertFrom-Json
    if (@($manifest.effects).Count -ne $expectedCount) { throw 'Published effect count did not match distinct exports.' }
    foreach ($type in @('particle', 'vfx', 'shader')) {
        if (-not @($manifest.effects | Where-Object { $_.type -eq $type }).Count) {
            throw "Published library is missing effect type $type."
        }
    }
    $override = @($manifest.effects | Where-Object { $_.name -eq 'InstanceOverride' })
    if ($override.Count -ne 1 -or $override[0].metadata.duration -ne 7) {
        throw 'Scene instance overrides did not survive prefab conversion, import and preview.'
    }
    foreach ($effect in $manifest.effects) {
        foreach ($relative in @($effect.files.package, $effect.files.thumbnail)) {
            if (-not $relative -or -not (Test-Path -LiteralPath (Join-Path $library $relative) -PathType Leaf)) {
                throw "Published file is missing: $relative"
            }
        }
    }
    Add-Type -AssemblyName System.Drawing
    foreach ($effect in $manifest.effects) {
        $image = [Drawing.Bitmap]::new((Join-Path $library $effect.files.thumbnail))
        try {
            if ([IO.Path]::GetExtension($effect.files.thumbnail) -ne '.gif' -or
                $image.GetFrameCount([Drawing.Imaging.FrameDimension]::Time) -ne 72) {
                throw 'Preview must be an animated GIF with 72 frames.'
            }
            $delays = $image.GetPropertyItem(0x5100).Value
            $duration = 0
            for ($index = 0; $index -lt 72; $index++) {
                $delay = [BitConverter]::ToUInt32($delays, $index * 4)
                if ($delay -notin @(4, 5)) { throw "Unexpected GIF frame delay: $delay" }
                $duration += $delay
            }
            if ($duration -ne 300) { throw "GIF duration must be 3 seconds, got $duration centiseconds." }
            if ($effect.name -eq 'FindFXTestParticle' -and $effect.type -eq 'shader') {
                $image.SelectActiveFrame([Drawing.Imaging.FrameDimension]::Time, 0) | Out-Null
                $early = $image.GetPixel(320, 180).R
                $image.SelectActiveFrame([Drawing.Imaging.FrameDimension]::Time, 48) | Out-Null
                $late = $image.GetPixel(320, 180).R
                if ($late - $early -lt 50) { throw "Shader time did not advance with the capture clock: $early -> $late." }
            }
            $image.SelectActiveFrame([Drawing.Imaging.FrameDimension]::Time, 18) | Out-Null
            if ($image.Width -ne 640 -or $image.Height -ne 360) {
                throw 'Preview dimensions must be 640 x 360.'
            }
                $background = $image.GetPixel(0, 0)
                $visible = 0
                $magenta = 0
                for ($y = 0; $y -lt $image.Height; $y += 2) {
                    for ($x = 0; $x -lt $image.Width; $x += 2) {
                        $pixel = $image.GetPixel($x, $y)
                        if ([Math]::Abs([int]$pixel.R - [int]$background.R) -gt 20 -or
                            [Math]::Abs([int]$pixel.G - [int]$background.G) -gt 20 -or
                            [Math]::Abs([int]$pixel.B - [int]$background.B) -gt 20) { $visible++ }
                        if ($pixel.R -gt 200 -and $pixel.B -gt 200 -and $pixel.G -lt 50) { $magenta++ }
                    }
                }
            if ($visible -lt 5 -or $magenta -gt 0) {
                throw "Preview for $($effect.name) is blank or has missing-shader pixels ($visible visible, $magenta magenta)."
            }
        } finally {
            $image.Dispose()
        }
    }
    if (Test-Path -LiteralPath (Join-Path $source 'Assets\Editor\EffectsExtractorPhase2')) {
        throw 'Pre-exported workflow injected scripts into the open source project.'
    }
    Write-Host 'PASS: Automatic server launch, locked source bypass, distinct Unity previews and persistent gallery files.'
    $passed = $true
} catch {
    Write-Host "Test diagnostics retained at $root"
    throw
} finally {
    if ($sourceLock) { $sourceLock.Dispose() }
    if ($worker) {
        if (-not $worker.WaitForExit(120000)) {
            throw "Preview worker $($worker.Id) did not finish cleanup within two minutes."
        }
        $worker.Dispose()
    }
    if ($server) {
        if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
        $server.WaitForExit()
        $server.Dispose()
    }
    Remove-Item Env:\FINDFX_TEST_OUTPUT -ErrorAction SilentlyContinue
    if ($passed) {
        Remove-Item -LiteralPath $root -Recurse -Force
        Remove-Item -LiteralPath (Join-Path $env:TEMP "EffectsExtractor-project-job-$Port.json") -Force
        $jobRoot = Split-Path -Parent ([string]$status.logPath)
        Remove-Item -LiteralPath $jobRoot -Recurse -Force
    }
}


