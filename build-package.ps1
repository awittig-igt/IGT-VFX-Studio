param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'outputs'))
$ErrorActionPreference = 'Stop'
$metadata = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$archive = Join-Path $OutputDirectory "$($metadata.name)-$($metadata.version).tgz"
$staging = Join-Path $env:TEMP ('ViewFXPackage_' + [Guid]::NewGuid().ToString('N'))
$package = Join-Path $staging 'package'
try {
    New-Item -ItemType Directory -Path $package -Force | Out-Null
    foreach ($name in @('Editor', 'Editor.meta', 'package.json', 'package.json.meta', 'README.md', 'README.md.meta', 'LICENSE', 'LICENSE.meta', 'Tools~')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $package -Recurse
    }
    & tar.exe -czf $archive -C $staging package
    if ($LASTEXITCODE -ne 0) { throw "Package creation failed: $LASTEXITCODE" }
    Write-Output $archive
} finally {
    $resolved = [IO.Path]::GetFullPath($staging)
    $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notlike 'ViewFXPackage_*') { throw 'Unsafe staging cleanup path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}

