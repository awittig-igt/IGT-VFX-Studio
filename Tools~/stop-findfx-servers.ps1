[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$stopped = 0
$failures = @()
# Match the exact disposable server layout, never arbitrary PowerShell processes.
$serverPattern = '(?i)(?:^|\s)-File\s+"?(?<script>' +
    [regex]::Escape($tempRoot) + '\\FindFX_[a-f0-9]{32}\\runtime\\serve\.ps1)"?(?=\s|$)'
foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'")) {
    if ($candidate.CommandLine -notmatch $serverPattern) { continue }
    $serverScript = $Matches['script']
    $runFolder = Split-Path -Parent (Split-Path -Parent $serverScript)
    $marker = Join-Path $runFolder 'server.pid'
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { continue }
    $recordedPid = 0
    if (-not [int]::TryParse(([IO.File]::ReadAllText($marker)).Trim(), [ref]$recordedPid) -or
        $recordedPid -ne $candidate.ProcessId) { continue }
    if ($PSCmdlet.ShouldProcess("FindFX server PID $recordedPid ($serverScript)", 'Stop')) {
        try {
            # Recheck identity in case the process exited and its PID was reused.
            $current = Get-CimInstance Win32_Process -Filter "ProcessId = $recordedPid"
            if (-not $current -or $current.CreationDate -ne $candidate.CreationDate -or
                $current.CommandLine -ne $candidate.CommandLine) { continue }
            Stop-Process -Id $recordedPid -Force -ErrorAction Stop
            $stopped++
        } catch {
            $failures += "PID ${recordedPid}: $($_.Exception.Message)"
        }
    }
}
Write-Output "Stopped $stopped FindFX server(s)."
if ($failures.Count) { throw ($failures -join [Environment]::NewLine) }
