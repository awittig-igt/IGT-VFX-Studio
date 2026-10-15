$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $repo 'Tools~'
$source = Join-Path $runtime 'BlankEffectsProject'
$root = Join-Path ([IO.Path]::GetTempPath()) ('FindFXOpenWebapp_' + [Guid]::NewGuid().ToString('N'))
$firstRun = Join-Path $root 'first'
$secondRun = Join-Path $root 'second'
$library = Join-Path $root 'library'
$serverProcess = $null
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
try {
    & (Join-Path $runtime 'start-findfx.ps1') -RuntimePath $runtime -SourceProjectPath $source `
        -RunPath $firstRun -LocalFolder $library -Port $port -StrictPort -OpenOnly -NoBrowser
    if (-not (Test-Path -LiteralPath (Join-Path $firstRun 'server.pid'))) {
        throw 'Opening the webapp did not start its server.'
    }
    $serverProcess = Get-Process -Id ([int](Get-Content -LiteralPath (Join-Path $firstRun 'server.pid') -Raw))
    $response = Invoke-WebRequest "http://localhost:$port/" -UseBasicParsing -TimeoutSec 10
    if ($response.StatusCode -ne 200) { throw 'The gallery did not load.' }
    & (Join-Path $runtime 'start-findfx.ps1') -RuntimePath $runtime -SourceProjectPath $source `
        -RunPath $secondRun -LocalFolder $library -Port $port -StrictPort -OpenOnly -NoBrowser
    if (Test-Path -LiteralPath (Join-Path $secondRun 'runtime')) {
        throw 'Opening the webapp twice started a second server.'
    }
    $status = Invoke-RestMethod "http://localhost:$port/api/project-extraction-job"
    if ($status.state -ne 'idle' -or (Test-Path -LiteralPath (Join-Path $firstRun 'worker.pid')) -or
        (Test-Path -LiteralPath (Join-Path $secondRun 'worker.pid'))) {
        throw 'Opening the webapp unexpectedly started extraction.'
    }
    Write-Output 'PASS: Open webapp starts/reuses the gallery server without extracting or launching Unity.'
} finally {
    if (-not $serverProcess -and (Test-Path -LiteralPath (Join-Path $firstRun 'server.pid'))) {
        $serverProcess = Get-Process -Id ([int](Get-Content -LiteralPath (Join-Path $firstRun 'server.pid') -Raw)) -ErrorAction SilentlyContinue
    }
    if ($serverProcess) {
        if (-not $serverProcess.HasExited) { Stop-Process -Id $serverProcess.Id -Force }
        $serverProcess.WaitForExit()
        $serverProcess.Dispose()
    }
    $resolvedRoot = [IO.Path]::GetFullPath($root)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolvedRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedRoot) -notmatch '^FindFXOpenWebapp_[a-f0-9]{32}$') {
        throw 'Unsafe test cleanup path.'
    }
    if (Test-Path -LiteralPath $resolvedRoot) { Remove-Item -LiteralPath $resolvedRoot -Recurse -Force }
}
