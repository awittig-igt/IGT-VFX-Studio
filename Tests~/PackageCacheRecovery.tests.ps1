$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $repo 'Tools~/unity-project-extraction-job.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors) { throw ($parseErrors -join "`n") }
foreach ($name in @('Write-ExtractionLog', 'Invoke-ExtractionUnity')) {
    $definition = $ast.Find({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('FindFXCacheRecovery_' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$logPath = Join-Path $root 'import.log'
$script:diagnosticLogPath = $null
$script:calls = 0
$script:delays = @()
$script:failure = "com.unity.collections: EPERM: operation not permitted, rename 'C:\Temp\FXP_test\Library\PackageCache\.tmp\package' -> 'C:\Temp\FXP_test\Library\PackageCache\com.unity.collections@hash'"
$script:succeedOn = 2
function Start-Sleep { param([int]$Seconds) $script:delays += $Seconds }
function Invoke-UnityEditorProcess {
    param([string]$EditorPath, [string[]]$Arguments)
    $script:calls++
    $exitCode = if ($script:calls -ge $script:succeedOn) { 0 } else { 1 }
    [IO.File]::WriteAllText($logPath, $(if ($exitCode) { $script:failure } else { 'Import succeeded' }))
    $result = [pscustomobject]@{ Id = $script:calls; ExitCode = $exitCode }
    $result | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
    return $result
}
function Assert($condition, $message) { if (-not $condition) { throw $message } }

try {
    $result = Invoke-ExtractionUnity 'Unity.exe' @('-batchmode') $logPath -RetryPackageCacheRename
    Assert ($result.ExitCode -eq 0 -and $script:calls -eq 2) 'Package-cache failure did not recover.'
    Assert ($script:delays.Count -eq 1 -and $script:delays[0] -eq 2) 'Retry did not back off.'
    Assert ((Get-Content (Join-Path $root 'import-attempt-1.log') -Raw).Contains('EPERM')) 'Failed-attempt log was lost.'

    $script:calls = 0
    $script:delays = @()
    $script:succeedOn = 99
    $result = Invoke-ExtractionUnity 'Unity.exe' @('-batchmode') $logPath -RetryPackageCacheRename
    Assert ($result.ExitCode -eq 1 -and $script:calls -eq 4) 'Retry limit was not enforced.'
    Assert (($script:delays -join ',') -eq '2,4,8') 'Retry backoff was incorrect.'

    $script:calls = 0
    $script:failure = 'error CS0246: Missing type'
    $result = Invoke-ExtractionUnity 'Unity.exe' @('-batchmode') $logPath -RetryPackageCacheRename
    Assert ($result.ExitCode -eq 1 -and $script:calls -eq 1) 'Unrelated compilation failure was retried.'

    $script:calls = 0
    $script:failure = "EPERM: operation not permitted, rename 'C:\Assets\file' -> 'C:\Assets\other'`nDiagnostics: C:\Temp\Library\PackageCache\example"
    $result = Invoke-ExtractionUnity 'Unity.exe' @('-batchmode') $logPath -RetryPackageCacheRename
    Assert ($script:calls -eq 1) 'An unrelated filesystem failure was retried.'

    $script:calls = 0
    $script:failure = "EPERM: operation not permitted, rename 'C:\Temp\Library\PackageCache\.tmp\package' -> 'C:\Temp\Library\PackageCache\package'"
    $result = Invoke-ExtractionUnity 'Unity.exe' @('-batchmode') $logPath
    Assert ($script:calls -eq 1) 'Retries were enabled outside the preview import phase.'
    Write-Output 'PASS: Package-cache recovery, preserved logs, bounded backoff and unrelated errors.'
} finally {
    $resolvedRoot = [IO.Path]::GetFullPath($root)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolvedRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedRoot) -notmatch '^FindFXCacheRecovery_[a-f0-9]{32}$') {
        throw 'Unsafe test cleanup path.'
    }
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
}
