$ErrorActionPreference = 'Stop'
$scriptUnderTest = Join-Path (Split-Path -Parent $PSScriptRoot) 'Tools~/stop-findfx-servers.ps1'
$runFolder = Join-Path ([IO.Path]::GetTempPath()) ('FindFX_' + [Guid]::NewGuid().ToString('N'))
$global:findFXTestStoppedIds = @()
$global:findFXTestCandidates = @()
function Get-CimInstance {
    param($ClassName, $Filter)
    if ($Filter -match '^ProcessId = (\d+)$') {
        return $global:findFXTestCandidates | Where-Object { $_.ProcessId -eq [int]$Matches[1] }
    }
    return $global:findFXTestCandidates
}
function Stop-Process {
    param($Id, [switch]$Force, $ErrorAction)
    $global:findFXTestStoppedIds += $Id
}
try {
    New-Item -ItemType Directory -Path $runFolder | Out-Null
    [IO.File]::WriteAllText((Join-Path $runFolder 'server.pid'), '12345')
    $scriptPath = Join-Path $runFolder 'runtime\serve.ps1'
    $global:findFXTestCandidates = @(
        [pscustomobject]@{ ProcessId = 12345; CreationDate = 'original'; CommandLine = "powershell.exe -NoProfile -File `"$scriptPath`" -Port 8080" },
        [pscustomobject]@{ ProcessId = 12346; CreationDate = 'other'; CommandLine = 'powershell.exe -File C:\Other\serve.ps1' },
        [pscustomobject]@{ ProcessId = 12347; CreationDate = 'stale'; CommandLine = "powershell.exe -File `"$scriptPath`" -Port 8081" },
        [pscustomobject]@{ ProcessId = 12348; CreationDate = 'launcher'; CommandLine = 'powershell.exe -EncodedCommand example' }
    )
    & $scriptUnderTest -WhatIf
    if ($global:findFXTestStoppedIds.Count -ne 0) { throw 'WhatIf stopped a process.' }
    & $scriptUnderTest
    if ($global:findFXTestStoppedIds.Count -ne 1 -or $global:findFXTestStoppedIds[0] -ne 12345) {
        throw 'Cleanup did not restrict termination to the verified FindFX server.'
    }
    $global:findFXTestStoppedIds = @()
    [IO.File]::WriteAllText((Join-Path $runFolder 'server.pid'), 'invalid')
    & $scriptUnderTest
    if ($global:findFXTestStoppedIds.Count -ne 0) { throw 'An invalid PID marker allowed termination.' }
    Write-Output 'PASS: FindFX cleanup selects verified servers, skips unrelated/stale processes, and supports WhatIf.'
} finally {
    # Delete only the single marker and empty test directory we created.
    Remove-Item -LiteralPath (Join-Path $runFolder 'server.pid') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $runFolder -Force -ErrorAction SilentlyContinue
}
