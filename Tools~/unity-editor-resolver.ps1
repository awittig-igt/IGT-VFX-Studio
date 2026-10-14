# Shared Unity Editor discovery for validation and extraction jobs.
# Projects are compatible with any installed editor in the same major family.
# Example: 2020.3.39f1 can use 2020.1.9f1, but not 2021.x or 6000.x.

function Get-UnityVersionFamily {
    param([string]$Version)
    if ([string]$Version -match '^\s*(\d+)') { return $Matches[1] }
    return ''
}

function Get-UnityVersionSortKey {
    param([string]$Version)
    if ([string]$Version -match '^\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?([abfp])?(\d+)?') {
        $stageRanks = @{ a = 1; b = 2; f = 3; p = 4 }
        $stage = if ($Matches[4] -and $stageRanks.ContainsKey($Matches[4])) { $stageRanks[$Matches[4]] } else { 5 }
        return '{0:D8}.{1:D8}.{2:D8}.{3:D2}.{4:D8}' -f
            [int]$Matches[1], [int]$Matches[2], [int]$Matches[3], $stage, [int]$Matches[5]
    }
    return [string]$Version
}

function Get-UnityProjectEditorVersion {
    param([string]$TargetProjectPath)
    $versionFile = Join-Path $TargetProjectPath 'ProjectSettings\ProjectVersion.txt'
    if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf)) {
        throw "Unity project version file not found: $versionFile"
    }
    $versionLine = Get-Content -LiteralPath $versionFile -ErrorAction Stop |
        Where-Object { $_ -match '^m_EditorVersion:' } |
        Select-Object -First 1
    $version = ($versionLine -replace '^m_EditorVersion:\s*', '').Trim()
    if (-not $version) { throw "Could not read m_EditorVersion from: $versionFile" }
    return $version
}

function Get-InstalledUnityEditors {
    $candidates = [Collections.Generic.List[object]]::new()
    $uninstallKeys = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )

    foreach ($entry in @(Get-ItemProperty $uninstallKeys -ErrorAction SilentlyContinue)) {
        $version = [string]$entry.DisplayVersion
        if (-not $version -and [string]$entry.DisplayName -match '^Unity\s+(\d[^\s]*)') {
            $version = $Matches[1]
        }
        $family = Get-UnityVersionFamily $version
        if (-not $family) { continue }

        $candidate = ''
        if ($entry.DisplayIcon) {
            $candidate = ([string]$entry.DisplayIcon -replace ',\s*\d+$', '').Trim().Trim('"')
        }
        if ((-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) -and $entry.InstallLocation) {
            $candidate = Join-Path ([string]$entry.InstallLocation) 'Editor\Unity.exe'
        }
        if ($candidate -and
            [IO.Path]::GetFileName($candidate) -ieq 'Unity.exe' -and
            (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            $candidates.Add([pscustomobject]@{
                version = $version
                family = $family
                path = [IO.Path]::GetFullPath($candidate)
                source = 'registry'
            })
        }
    }

    $editorRoots = @(
        'C:\Program Files\Unity\Hub\Editor',
        'C:\Program Files\Unity',
        'C:\Program Files',
        'E:\Installers',
        'E:\Unity',
        'E:\'
    )
    foreach ($root in $editorRoots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        foreach ($folder in @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
            $version = if ($folder.Name -match '^Unity\s+(\d[^\s]*)$') { $Matches[1] } else { $folder.Name }
            $family = Get-UnityVersionFamily $version
            if (-not $family) { continue }
            $candidate = Join-Path $folder.FullName 'Editor\Unity.exe'
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $candidates.Add([pscustomobject]@{
                    version = $version
                    family = $family
                    path = [IO.Path]::GetFullPath($candidate)
                    source = "folder:$root"
                })
            }
        }
    }

    $unique = [ordered]@{}
    foreach ($candidate in $candidates) {
        if (-not $unique.Contains($candidate.path)) {
            $unique[$candidate.path] = $candidate
        }
    }
    return @($unique.Values)
}

function Resolve-UnityEditorForProject {
    param(
        [string]$TargetProjectPath,
        [object[]]$InstalledEditors = $null
    )

    $reasons = [Collections.Generic.List[string]]::new()
    $projectVersion = ''
    try {
        $projectVersion = Get-UnityProjectEditorVersion $TargetProjectPath
    } catch {
        $reasons.Add($_.Exception.Message)
    }
    $family = Get-UnityVersionFamily $projectVersion
    if ($projectVersion -and -not $family) {
        $reasons.Add("Unity version '$projectVersion' has no recognizable major family.")
    }

    if ($null -eq $InstalledEditors) {
        $InstalledEditors = @(Get-InstalledUnityEditors)
    }
    $familyCandidates = @($InstalledEditors | Where-Object {
        (Get-UnityVersionFamily ([string]$_.version)) -eq $family
    })
    $selected = $familyCandidates |
        Where-Object { [string]$_.version -ieq $projectVersion } |
        Select-Object -First 1
    $matchType = if ($selected) { 'exact' } else { 'none' }

    if (-not $selected -and $familyCandidates.Count -gt 0) {
        $selected = $familyCandidates |
            Sort-Object -Property @{ Expression = { Get-UnityVersionSortKey ([string]$_.version) }; Descending = $true } |
            Select-Object -First 1
        $matchType = 'family'
    }

    if ($projectVersion -and -not $selected) {
        $installedVersions = @($InstalledEditors | ForEach-Object { [string]$_.version } | Sort-Object -Unique)
        $installedText = if ($installedVersions.Count) { $installedVersions -join ', ' } else { 'none detected' }
        $reasons.Add(
            "No installed Unity $family editor was found for project $projectVersion. " +
            "Minor and patch versions are exempt; install any Unity $family editor. Detected editors: $installedText"
        )
    }

    return [pscustomobject]@{
        found = [bool]$selected
        projectVersion = $projectVersion
        requiredFamily = $family
        selectedVersion = if ($selected) { [string]$selected.version } else { '' }
        selectedPath = if ($selected) { [string]$selected.path } else { '' }
        matchType = $matchType
        familyExemptionUsed = $matchType -eq 'family'
        compatibleVersions = @($familyCandidates | ForEach-Object { [string]$_.version } | Sort-Object -Unique)
        reasons = @($reasons)
    }
}
