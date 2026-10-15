param(
    [Parameter(Mandatory = $true)][string]$RuntimePath,
    [Parameter(Mandatory = $true)][string]$SourceProjectPath,
    [Parameter(Mandatory = $true)][string]$PreExportedPath,
    [Parameter(Mandatory = $true)][string]$LocalFolder,
    [ValidateRange(1024, 65535)][int]$Port = 8080,
    [switch]$StrictPort,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$server = $null

function Test-PortOccupied([int]$testPort) {
    $tcp = New-Object Net.Sockets.TcpClient
    try {
        $connection = $tcp.ConnectAsync('localhost', $testPort)
        return ($connection.Wait(1000) -and $tcp.Connected)
    } catch [AggregateException] {
        return $false
    } finally {
        $tcp.Dispose()
    }
}

try {
    $requestedPort = $Port
    $LocalFolder = [IO.Path]::GetFullPath($LocalFolder)
    $baseUrl = "http://localhost:$Port"
    $config = $null
    $reusingExistingServer = $false

    # Check whether the requested port is in use
    $occupied = Test-PortOccupied $Port
    if ($occupied) {
        try {
            $config = Invoke-RestMethod "$baseUrl/api/config" -TimeoutSec 5
        } catch {
            $config = $null
        }

        if ($config -and $config.capabilities.findFX -and $config.capabilities.multiEffectPackages -and $config.capabilities.packageCacheRecovery -and
            ([IO.Path]::GetFullPath([string]$config.localFolder).TrimEnd('\') -eq $LocalFolder.TrimEnd('\'))) {
            $reusingExistingServer = $true
            Write-Host "Reusing existing FindFX server on port $Port."
        } else {
            if ($StrictPort) {
                if ($config -and $config.capabilities.findFX) {
                    throw "The server on port $Port uses an older FindFX runtime or another library folder ($($config.localFolder)). Choose another port in FindFX."
                }
                throw "Port $Port is used by another service or an older EffectsExtractor server. Choose another port in FindFX."
            }

            # Find next free port or existing compatible server for this library
            $foundPort = $false
            for ($tryPort = $Port + 1; $tryPort -le [Math]::Min($Port + 100, 65535); $tryPort++) {
                if (-not (Test-PortOccupied $tryPort)) {
                    $Port = $tryPort
                    $baseUrl = "http://localhost:$Port"
                    $foundPort = $true
                    Write-Host "Port $requestedPort is in use. Using port $Port instead."
                    break
                }
                try {
                    $tryUrl = "http://localhost:$tryPort"
                    $tryConfig = Invoke-RestMethod "$tryUrl/api/config" -TimeoutSec 2
                    if ($tryConfig -and $tryConfig.capabilities.findFX -and $tryConfig.capabilities.multiEffectPackages -and $tryConfig.capabilities.packageCacheRecovery -and
                        ([IO.Path]::GetFullPath([string]$tryConfig.localFolder).TrimEnd('\') -eq $LocalFolder.TrimEnd('\'))) {
                        $Port = $tryPort
                        $baseUrl = $tryUrl
                        $config = $tryConfig
                        $reusingExistingServer = $true
                        $foundPort = $true
                        Write-Host "Reusing existing FindFX server on port $Port."
                        break
                    }
                } catch { }
            }

            if (-not $foundPort) {
                if ($config -and $config.capabilities.findFX) {
                    throw "The server on port $requestedPort uses another library folder ($($config.localFolder)), and no free port was found near $requestedPort."
                }
                throw "Port $requestedPort is in use by another service, and no free port was found near $requestedPort."
            }
        }
    }

    if (-not $reusingExistingServer) {
        # Package Manager caches may be read-only. Run all mutable server state outside the package.
        $runRoot = Split-Path -Parent ([IO.Path]::GetFullPath($PreExportedPath))
        $workingRuntime = Join-Path $runRoot 'runtime'
        New-Item -ItemType Directory -Path $workingRuntime | Out-Null
        Copy-Item -Path (Join-Path $RuntimePath '*') -Destination $workingRuntime -Recurse
        $preview = Join-Path $workingRuntime 'BlankEffectsProject'
        $serverLog = Join-Path $runRoot 'server.log'
        $serverErrors = Join-Path $runRoot 'server-errors.log'
        $arguments = @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f (Join-Path $workingRuntime 'serve.ps1')),
            '-Port', [string]$Port, '-StrictPort', '-NoBrowser',
            '-LocalFolder', ('"{0}"' -f $LocalFolder),
            '-SourceProjectPath', ('"{0}"' -f $SourceProjectPath),
            '-PreviewProjectPath', ('"{0}"' -f $preview)
        )
        $server = Start-Process powershell.exe -ArgumentList $arguments -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $serverLog -RedirectStandardError $serverErrors
        $server.Id | Set-Content -LiteralPath (Join-Path $runRoot 'server.pid') -Encoding ASCII
        $deadline = [DateTime]::UtcNow.AddSeconds(60)
        while ([DateTime]::UtcNow -lt $deadline) {
            $server.Refresh()
            if ($server.HasExited) {
                throw "FindFX server exited ($($server.ExitCode)). $(Get-Content -LiteralPath $serverErrors -Raw) See $serverLog."
            }
            try {
                $config = Invoke-RestMethod "$baseUrl/api/config" -TimeoutSec 2
                break
            } catch [Net.WebException] {
                Start-Sleep -Milliseconds 500
            }
        }
        if (-not $config -or -not $config.capabilities.findFX -or -not $config.capabilities.multiEffectPackages -or -not $config.capabilities.packageCacheRecovery) {
            throw "FindFX server did not become responsive within 60 seconds. See $serverLog."
        }
    }
    $payload = @{
        sourceProjectPath = [IO.Path]::GetFullPath($SourceProjectPath)
        preExportedPath = [IO.Path]::GetFullPath($PreExportedPath)
        gameName = Split-Path $SourceProjectPath -Leaf
    } | ConvertTo-Json
    $job = Invoke-RestMethod "$baseUrl/api/findfx" -Method Post -ContentType 'application/json' -Body $payload -TimeoutSec 60
    if (-not $job.ok) { throw 'FindFX server did not accept the preview job.' }
    $job.job.workerProcessId | Set-Content -LiteralPath (Join-Path (Split-Path -Parent $PreExportedPath) 'worker.pid') -Encoding ASCII
    if (-not $NoBrowser) { Start-Process "$baseUrl/?findfx=1" }
    Write-Host "FindFX preview job $($job.job.jobId) started at $baseUrl/?findfx=1"
} catch {
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id -Force
    }
    [Console]::Error.WriteLine($_)
    Write-Output "FindFX launch failed: $_"
    exit 1
}
