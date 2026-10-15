# serve.ps1 — HTTP server for the Effects Library webapp
# Usage:  .\serve.ps1
# Usage:  .\serve.ps1 -SourceProjectPath "E:\Games\MyGame" -PreviewProjectPath ".\BlankEffectsProject"

param(
    [int]$Port               = 8080,
    [string]$LocalFolder      = "",
    [string]$SourceProjectPath = "",
    [string]$PreviewProjectPath = "",
    # Backward-compatible alias for the preview/container project.
    [string]$UnityProjectPath = "",
    [switch]$NoBrowser        = $false,
    [switch]$StrictPort       = $false,
    # Packages are held in memory while uploaded; keep the local endpoint bounded.
    [ValidateRange(1, 2048)]
    [int]$MaxUploadMb         = 512
)

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }

$unityEditorResolverPath = Join-Path $scriptDir 'unity-editor-resolver.ps1'
if (-not (Test-Path -LiteralPath $unityEditorResolverPath -PathType Leaf)) {
    throw "Unity editor resolver not found: $unityEditorResolverPath"
}
. $unityEditorResolverPath

$serverConfigPath = Join-Path $scriptDir '.effects-extractor-config.json'
if (Test-Path -LiteralPath $serverConfigPath -PathType Leaf) {
    try {
        $savedServerConfig = Get-Content -LiteralPath $serverConfigPath -Raw | ConvertFrom-Json
        if (-not $LocalFolder -and $savedServerConfig.localFolder) {
            $LocalFolder = [string]$savedServerConfig.localFolder
        }
        if (-not $SourceProjectPath -and $savedServerConfig.sourceProjectPath) {
            $SourceProjectPath = [string]$savedServerConfig.sourceProjectPath
        }
        if (-not $PreviewProjectPath -and $savedServerConfig.previewProjectPath) {
            $PreviewProjectPath = [string]$savedServerConfig.previewProjectPath
        } elseif (-not $PreviewProjectPath -and $savedServerConfig.unityProjectPath) {
            $PreviewProjectPath = [string]$savedServerConfig.unityProjectPath
        }
    } catch {
        Write-Host "  WARN Could not read saved server configuration: $_" -ForegroundColor Yellow
    }
}

function Resolve-ServerPath([string]$path) {
    if (-not $path) { return '' }
    $expanded = [Environment]::ExpandEnvironmentVariables($path.Trim().Trim('"'))
    if (-not [IO.Path]::IsPathRooted($expanded)) { $expanded = Join-Path $scriptDir $expanded }
    return [IO.Path]::GetFullPath($expanded)
}

function Resolve-PathWithinRoot([string]$root, [string]$relativePath) {
    if (-not $relativePath) { return $null }
    $rootPath = [IO.Path]::GetFullPath($root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $candidate = [IO.Path]::GetFullPath((Join-Path $rootPath ($relativePath -replace '/', [IO.Path]::DirectorySeparatorChar)))
    $prefix = $rootPath + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    return $candidate
}

function Get-UnityProjectValidation {
    param(
        [string]$path
    )
    $details = [ordered]@{
        valid = $false
        inputPath = [string]$path
        resolvedPath = ''
        pathExists = $false
        isDirectory = $false
        assetsDirectoryExists = $false
        projectSettingsDirectoryExists = $false
        projectVersionFileExists = $false
        projectVersionReadable = $false
        packagesManifestExists = $false
        editorVersion = ''
        editorVersionFamily = ''
        compatibleEditorInstalled = $false
        compatibleEditorVersion = ''
        compatibleEditorPath = ''
        editorMatchType = 'none'
        editorFamilyExemptionUsed = $false
        compatibleEditorVersions = @()
        reasons = @()
        checkedAt = [DateTime]::UtcNow.ToString('o')
    }
    $reasons = [Collections.Generic.List[string]]::new()

    if (-not $path) {
        $reasons.Add('No project path was provided.')
        $details.reasons = @($reasons)
        return [pscustomobject]$details
    }

    try {
        $details.resolvedPath = Resolve-ServerPath $path
    } catch {
        $reasons.Add("The project path could not be resolved: $($_.Exception.Message)")
        $details.reasons = @($reasons)
        return [pscustomobject]$details
    }

    $assetsPath = Join-Path $details.resolvedPath 'Assets'
    $projectSettingsPath = Join-Path $details.resolvedPath 'ProjectSettings'
    $projectVersionPath = Join-Path $projectSettingsPath 'ProjectVersion.txt'
    $packagesManifestPath = Join-Path $details.resolvedPath 'Packages\manifest.json'

    try {
        $details.pathExists = Test-Path -LiteralPath $details.resolvedPath
        $details.isDirectory = Test-Path -LiteralPath $details.resolvedPath -PathType Container
        $details.assetsDirectoryExists = Test-Path -LiteralPath $assetsPath -PathType Container
        $details.projectSettingsDirectoryExists = Test-Path -LiteralPath $projectSettingsPath -PathType Container
        $details.projectVersionFileExists = Test-Path -LiteralPath $projectVersionPath -PathType Leaf
        $details.packagesManifestExists = Test-Path -LiteralPath $packagesManifestPath -PathType Leaf
    } catch {
        $reasons.Add("The project path could not be inspected: $($_.Exception.Message)")
    }

    if (-not $details.pathExists) {
        $reasons.Add("Project folder does not exist: $($details.resolvedPath)")
    } elseif (-not $details.isDirectory) {
        $reasons.Add("Project path is not a folder: $($details.resolvedPath)")
    } else {
        if (-not $details.assetsDirectoryExists) {
            $reasons.Add("Missing Assets folder: $assetsPath")
        }
        if (-not $details.projectSettingsDirectoryExists) {
            $reasons.Add("Missing ProjectSettings folder: $projectSettingsPath")
        }
        if (-not $details.projectVersionFileExists) {
            $reasons.Add("Missing Unity version file: $projectVersionPath")
        } else {
            try {
                $versionLine = Get-Content -LiteralPath $projectVersionPath -TotalCount 1 -ErrorAction Stop
                $details.projectVersionReadable = $true
                if ($versionLine -match '^m_EditorVersion:\s*(.+)$') {
                    $details.editorVersion = $Matches[1].Trim()
                    $details.editorVersionFamily = Get-UnityVersionFamily $details.editorVersion
                }
            } catch {
                $reasons.Add("Unity version file is not readable: $projectVersionPath ($($_.Exception.Message))")
            }
        }
    }

    if ($details.editorVersion) {
        $editorResolution = Resolve-UnityEditorForProject -TargetProjectPath $details.resolvedPath -InstalledEditors $script:installedUnityEditors
        $details.compatibleEditorInstalled = $editorResolution.found
        $details.compatibleEditorVersion = $editorResolution.selectedVersion
        $details.compatibleEditorPath = $editorResolution.selectedPath
        $details.editorMatchType = $editorResolution.matchType
        $details.editorFamilyExemptionUsed = $editorResolution.familyExemptionUsed
        $details.compatibleEditorVersions = @($editorResolution.compatibleVersions)
        if (-not $editorResolution.found) {
            foreach ($reason in @($editorResolution.reasons)) { $reasons.Add($reason) }
        }
    }

    $details.valid = $details.isDirectory -and
        $details.assetsDirectoryExists -and
        $details.projectSettingsDirectoryExists -and
        $details.projectVersionFileExists -and
        $details.projectVersionReadable -and
        $details.compatibleEditorInstalled
    $details.reasons = @($reasons)
    return [pscustomobject]$details
}

function Test-UnityProject([string]$path) {
    return (Get-UnityProjectValidation $path).valid
}

function Write-UnityProjectValidation([string]$label, $validation) {
    $result = if ($validation.valid) { 'PASS' } else { 'FAIL' }
    $color = if ($validation.valid) { 'Green' } else { 'Yellow' }
    Write-Host "  VALIDATE $label : $result" -ForegroundColor $color
    Write-Host "    Path              : $($validation.resolvedPath)" -ForegroundColor DarkGray
    Write-Host "    Project folder    : $($validation.isDirectory)" -ForegroundColor DarkGray
    Write-Host "    Assets folder     : $($validation.assetsDirectoryExists)" -ForegroundColor DarkGray
    Write-Host "    ProjectSettings   : $($validation.projectSettingsDirectoryExists)" -ForegroundColor DarkGray
    Write-Host "    ProjectVersion.txt: $($validation.projectVersionFileExists) (readable=$($validation.projectVersionReadable))" -ForegroundColor DarkGray
    if ($validation.editorVersion) {
        Write-Host "    Unity version     : $($validation.editorVersion)" -ForegroundColor DarkGray
    }
    Write-Host "    Editor family     : $($validation.editorVersionFamily)" -ForegroundColor DarkGray
    Write-Host "    Compatible editor : $($validation.compatibleEditorInstalled)" -ForegroundColor DarkGray
    if ($validation.compatibleEditorInstalled) {
        Write-Host "    Selected editor   : $($validation.compatibleEditorVersion) [$($validation.editorMatchType)]" -ForegroundColor DarkGray
        Write-Host "    Editor path       : $($validation.compatibleEditorPath)" -ForegroundColor DarkGray
    }
    foreach ($reason in @($validation.reasons)) {
        Write-Host "    Reason            : $reason" -ForegroundColor Yellow
    }
}

function Throw-UnityProjectValidationError([string]$label, $validation) {
    $reasonText = @($validation.reasons) -join ' '
    if (-not $reasonText) { $reasonText = 'The required Unity project files could not be verified.' }
    $exception = [ArgumentException]::new("Not a valid $label project. $reasonText")
    $exception.Data['validationJson'] = $validation | ConvertTo-Json -Compress -Depth 5
    $exception.Data['statusCode'] = 400
    throw $exception
}

function Save-ServerConfiguration {
    $config = @{
        version = 2
        localFolder = $LocalFolder
        sourceProjectPath = $SourceProjectPath
        previewProjectPath = $PreviewProjectPath
        updatedAt = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($serverConfigPath, $config, [Text.UTF8Encoding]::new($false))
}

if ($LocalFolder) { $LocalFolder = Resolve-ServerPath $LocalFolder }
if (-not $PreviewProjectPath -and $UnityProjectPath) { $PreviewProjectPath = $UnityProjectPath }
if (-not $PreviewProjectPath) { $PreviewProjectPath = Join-Path $scriptDir 'BlankEffectsProject' }
if ($SourceProjectPath) { $SourceProjectPath = Resolve-ServerPath $SourceProjectPath }
if ($PreviewProjectPath) { $PreviewProjectPath = Resolve-ServerPath $PreviewProjectPath }
# Existing upload-package code uses this name for the preview container.
$UnityProjectPath = $PreviewProjectPath

$installedUnityEditors = @(Get-InstalledUnityEditors)

$webRoot = Join-Path $scriptDir "webapp"
if (-not (Test-Path $webRoot)) {
    Write-Host "  ERROR: 'webapp' folder not found at: $webRoot" -ForegroundColor Red
    exit 1
}

if (-not $LocalFolder) { $LocalFolder = Join-Path $scriptDir "local-effects" }
if (-not (Test-Path $LocalFolder)) { New-Item -ItemType Directory -Force -Path $LocalFolder | Out-Null }

$mimeTypes = @{
    '.html'  = 'text/html; charset=utf-8'
    '.css'   = 'text/css; charset=utf-8'
    '.js'    = 'application/javascript; charset=utf-8'
    '.json'  = 'application/json; charset=utf-8'
    '.png'   = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'
    '.gif'   = 'image/gif'; '.svg' = 'image/svg+xml'
    '.ico'   = 'image/x-icon'; '.webp' = 'image/webp'
}

$baseUrl  = "http://localhost:$Port/"
$requestedPort = $Port
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($baseUrl)

# If the requested port is blocked, find the next free one automatically
$testStart = try { $listener.Start(); $true } catch { $false }
if (-not $testStart) {
    $listener.Close()
    if ($StrictPort) {
        throw "FindFX could not bind port $Port. Choose another port."
    }
    $found = $false
    for ($try = $Port + 1; $try -lt $Port + 100; $try++) {
            $Port     = $try
            $baseUrl  = "http://localhost:$Port/"
            $listener = [System.Net.HttpListener]::new()
            $listener.Prefixes.Add($baseUrl)
            try { $listener.Start(); $found = $true; break } catch { $listener.Close() }
    }
    if (-not $found) {
        Write-Host "  ERROR: Could not find a free port near $Port." -ForegroundColor Red
        exit 1
    }
    Write-Host "  (Port $requestedPort was unavailable - using $Port)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Effects Extractor Library :  $baseUrl" -ForegroundColor Green
Write-Host "  Local effects    :  $LocalFolder" -ForegroundColor Cyan
if ($SourceProjectPath) { Write-Host "  Game project     :  $SourceProjectPath" -ForegroundColor Cyan }
if ($PreviewProjectPath) { Write-Host "  Preview project  :  $PreviewProjectPath" -ForegroundColor Cyan }
Write-Host "  Unity editors    :  $($installedUnityEditors.Count) detected" -ForegroundColor Cyan
if ($SourceProjectPath) { Write-UnityProjectValidation 'Source Game Project' (Get-UnityProjectValidation $SourceProjectPath) }
if ($PreviewProjectPath) { Write-UnityProjectValidation 'Preview Container' (Get-UnityProjectValidation $PreviewProjectPath) }
Write-Host "  Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

$packageJobStatusPath = Join-Path $env:TEMP "EffectsExtractor-package-job-$Port.json"
$projectJobStatusPath = Join-Path $env:TEMP "EffectsExtractor-project-job-$Port.json"
$projectJobProcess = $null
$lastUploadedPackage  = $null

if (-not $NoBrowser) { Start-Process $baseUrl }

function Send-Cors($res) {
    # The bundled web app is normally served from this listener, but these
    # headers also support local development from another localhost origin.
    $res.Headers['Access-Control-Allow-Origin'] = '*'
    $res.Headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    $res.Headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Filename'
}

function Send-Json($res, $obj, [int]$status = 200) {
    $json  = $obj | ConvertTo-Json -Compress -Depth 10
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $res.StatusCode      = $status
    $res.ContentType     = 'application/json; charset=utf-8'
    $res.ContentLength64 = $bytes.LongLength
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
}
function Serve-File($res, $filePath, $rawPath) {
    $ext   = [IO.Path]::GetExtension($filePath).ToLower()
    $mime  = if ($mimeTypes[$ext]) { $mimeTypes[$ext] } else { 'application/octet-stream' }
    $bytes = [IO.File]::ReadAllBytes($filePath)
    $res.StatusCode      = 200
    $res.ContentType     = $mime
    $res.ContentLength64 = $bytes.LongLength
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
    Write-Host "  200  $rawPath" -ForegroundColor DarkGreen
}
function Serve-Download($res, $filePath, $rawPath) {
    $safeName = [IO.Path]::GetFileName($filePath).Replace('"', '')
    $res.AddHeader('Content-Disposition', ('attachment; filename="{0}"' -f $safeName))
    Serve-File $res $filePath $rawPath
}

function Find-UnityPackageForAsset($assetPath) {
    if (-not $UnityProjectPath -or -not $assetPath) { return $null }
    $packageFolder = Join-Path $UnityProjectPath 'Assets\ImportedPackages'
    if (-not (Test-Path -LiteralPath $packageFolder)) { return $null }

    foreach ($package in (Get-ChildItem -LiteralPath $packageFolder -Filter '*.unitypackage' -File)) {
        try {
            $pathEntries = @(& tar.exe -tf $package.FullName | Where-Object { $_ -like '*/pathname' })
            foreach ($entry in $pathEntries) {
                $packagedAssetPath = ((& tar.exe -xOf $package.FullName $entry) -join "`n").Trim()
                if ($packagedAssetPath -ieq $assetPath) { return $package }
            }
        } catch {
            Write-Host "  WARN Could not inspect package $($package.Name): $_" -ForegroundColor Yellow
        }
    }
    return $null
}

function Start-PackageJob($packagePath) {
    if (-not $UnityProjectPath) { throw 'Unity Project Path is not configured.' }
    if (-not (Test-Path -LiteralPath $UnityProjectPath)) { throw "Unity project not found: $UnityProjectPath" }

    $runner = Join-Path $scriptDir 'unity-package-job.ps1'
    if (-not (Test-Path -LiteralPath $runner)) { throw "Unity job runner not found: $runner" }

    $captureDir = Join-Path (Split-Path $UnityProjectPath -Parent) 'ThumbnailCaptures'
    @{
        state = 'queued'; phase = 'upload'; progress = 10
        message = 'Package uploaded. Waiting for Unity...'
        captureCount = 0; updatedAt = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $packageJobStatusPath -Encoding UTF8

    # When this project is already open, ask that Editor instance to do the work.
    # This keeps the imported prefab and the generated capture scene visible to the user.
    $projectLock = Join-Path $UnityProjectPath 'Temp\UnityLockfile'
    $projectIsOpen = $false
    if (Test-Path -LiteralPath $projectLock) {
        try {
            $lockStream = [IO.File]::Open($projectLock, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            $lockStream.Dispose()
        } catch {
            $projectIsOpen = $true
        }
    }

    if ($projectIsOpen) {
        $requestPath = Join-Path $UnityProjectPath 'Assets\Editor\EffectsExtractorRequest.json'
        $requestDir = Split-Path $requestPath -Parent
        if (-not (Test-Path -LiteralPath $requestDir)) { New-Item -ItemType Directory -Force -Path $requestDir | Out-Null }
        $request = @{
            packagePath = [IO.Path]::GetFullPath($packagePath)
            outputPath = [IO.Path]::GetFullPath($captureDir)
            statusPath = [IO.Path]::GetFullPath($packageJobStatusPath)
            phase = 'queued'
        } | ConvertTo-Json
        [IO.File]::WriteAllText($requestPath, $request, [Text.UTF8Encoding]::new($false))
        Write-Host "  UNITY  Request sent to the open Editor: $requestPath" -ForegroundColor Magenta
        return
    }

    $arguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $runner),
        '-ProjectPath', ('"{0}"' -f $UnityProjectPath),
        '-PackagePath', ('"{0}"' -f $packagePath),
        '-OutputPath', ('"{0}"' -f $captureDir),
        '-StatusPath', ('"{0}"' -f $packageJobStatusPath)
    )
    Start-Process powershell.exe -ArgumentList $arguments -WindowStyle Hidden
}

function Start-ProjectExtractionJob($gameName, [string]$preExportedPath = '', [string]$findFXSourcePath = '') {
    if (-not $SourceProjectPath -and -not $findFXSourcePath) { throw 'Source Game Project Path is not configured.' }
    if (-not $PreviewProjectPath) { throw 'Preview Container Project Path is not configured.' }
    $sourcePath = if ($findFXSourcePath) { [IO.Path]::GetFullPath($findFXSourcePath) } else { [IO.Path]::GetFullPath($SourceProjectPath) }
    $previewPath = [IO.Path]::GetFullPath($PreviewProjectPath)
    if (-not $preExportedPath -and -not (Test-UnityProject $sourcePath)) { throw "Source game project is invalid or incomplete: $sourcePath" }
    if ($preExportedPath -and
        (-not (Test-Path -LiteralPath (Join-Path $sourcePath 'Assets') -PathType Container) -or
         -not (Test-Path -LiteralPath (Join-Path $sourcePath 'ProjectSettings') -PathType Container))) {
        throw "FindFX source is not a Unity project: $sourcePath"
    }
    if (-not (Test-UnityProject $previewPath)) { throw "Preview container project is invalid or incomplete: $previewPath" }
    if ($sourcePath -eq $previewPath) {
        throw 'The source game project and preview container must be different Unity projects.'
    }

    if (Test-Path -LiteralPath $projectJobStatusPath -PathType Leaf) {
        try {
            $existingStatus = Get-Content -LiteralPath $projectJobStatusPath -Raw | ConvertFrom-Json
            if ($existingStatus.state -in @('queued', 'running')) {
                throw 'A Unity project extraction job is already running.'
            }
        } catch {
            if ($_.Exception.Message -eq 'A Unity project extraction job is already running.') { throw }
        }
    }

    $runner = Join-Path $scriptDir 'unity-project-extraction-job.ps1'
    if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
        throw "Unity project extraction runner not found: $runner"
    }
    $automationSource = Join-Path $scriptDir 'extractor\unity-tools'
    foreach ($scriptName in @('ParticlePackageExporterV2.cs', 'EffectsThumbnailCaptureV2.cs')) {
        $scriptPath = Join-Path $automationSource $scriptName
        if ($scriptName -eq 'ParticlePackageExporterV2.cs' -and -not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
            $scriptPath = Join-Path $scriptDir 'packages\com.igt.findfx\Editor\ParticlePackageExporterV2.cs'
        }
        if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
            throw "Unity automation source is missing: $scriptName"
        }
    }

    $resolvedGameName = if ($gameName) { [string]$gameName } else { Split-Path $sourcePath -Leaf }
    $jobId = [Guid]::NewGuid().ToString('N')
    $jobRoot = Join-Path $env:TEMP "EffectsExtractorProjectJob_$jobId"
    $packageOutput = Join-Path $jobRoot 'packages'
    $captureOutput = Join-Path $jobRoot 'captures'
    New-Item -ItemType Directory -Force -Path $jobRoot | Out-Null
    $diagnosticLogPath = Join-Path $jobRoot 'extraction.log'
    "[{0}] Queued extraction for '{1}'." -f [DateTime]::UtcNow.ToString('o'), $resolvedGameName |
        Set-Content -LiteralPath $diagnosticLogPath -Encoding UTF8

    @{
        state = 'queued'; phase = 'queued'; progress = 5
        message = 'Project extraction queued. Waiting for Unity...'
        exportCount = 0; captureCount = 0; libraryCount = 0
        warnings = @(); updatedAt = [DateTime]::UtcNow.ToString('o')
        logPath = $diagnosticLogPath
    } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $projectJobStatusPath -Encoding UTF8

    $arguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $runner),
        '-SourceProjectPath', ('"{0}"' -f $sourcePath),
        '-PreviewProjectPath', ('"{0}"' -f $previewPath),
        '-AutomationSourcePath', ('"{0}"' -f $automationSource),
        '-OutputPath', ('"{0}"' -f $packageOutput),
        '-CapturePath', ('"{0}"' -f $captureOutput),
        '-LocalFolder', ('"{0}"' -f ([IO.Path]::GetFullPath($LocalFolder))),
        '-StatusPath', ('"{0}"' -f $projectJobStatusPath),
        '-GameName', ('"{0}"' -f $resolvedGameName.Replace('"', ''))
    )
    if ($preExportedPath) {
        $arguments += @('-PreExportedPath', ('"{0}"' -f ([IO.Path]::GetFullPath($preExportedPath))))
    }
    try {
        $script:projectJobProcess = Start-Process powershell.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $jobRoot 'worker-output.log') `
            -RedirectStandardError (Join-Path $jobRoot 'worker-errors.log')
    } catch {
        $failure = $_
        Add-Content -LiteralPath $diagnosticLogPath -Value $failure.Exception.ToString() -Encoding UTF8
        @{
            state = 'failed'; phase = 'error'; progress = 100
            message = "Could not start extraction worker: $($failure.Exception.Message)"
            logPath = $diagnosticLogPath; updatedAt = [DateTime]::UtcNow.ToString('o')
        } | ConvertTo-Json | Set-Content -LiteralPath $projectJobStatusPath -Encoding UTF8
        $failure.Exception.Data['logAvailable'] = $true
        throw
    }
    Write-Host "  UNITY  Scanning $sourcePath and previewing in $previewPath" -ForegroundColor Magenta
    return @{
        jobId = $jobId
        workerProcessId = $projectJobProcess.Id
        sourceProjectPath = $sourcePath
        previewProjectPath = $previewPath
        gameName = $resolvedGameName
    }
}

try {
    while ($listener.IsListening) {
        $ctx = $null
        try { $ctx = $listener.GetContext() } catch { break }

        $req     = $ctx.Request
        $res     = $ctx.Response
        $method  = $req.HttpMethod
        $rawPath = $req.Url.LocalPath
        Send-Cors $res

        try {
            # OPTIONS pre-flight
            if ($method -eq 'OPTIONS') {
                $res.StatusCode = 204
            }

            # GET /api/config
            elseif ($method -eq 'GET' -and $rawPath -eq '/api/config') {
                $sourceValidation = Get-UnityProjectValidation $SourceProjectPath
                $previewValidation = Get-UnityProjectValidation $PreviewProjectPath
                Send-Json $res @{
                    apiVersion = 4
                    capabilities = @{
                        projectExtraction = $true
                        findFX = $true
                        projectExtractionStatus = $true
                        separateSourceAndPreview = $true
                        sanitizedParticlePackages = $true
                        multiEffectPackages = $true
                        disposablePreviewWorkspace = $true
                    }
                    localFolder = $LocalFolder
                    sourceProjectPath = $SourceProjectPath
                    sourceProjectValid = $sourceValidation.valid
                    sourceProjectValidation = $sourceValidation
                    previewProjectPath = $PreviewProjectPath
                    previewProjectValid = $previewValidation.valid
                    previewProjectValidation = $previewValidation
                    unityProjectPath = $PreviewProjectPath
                    unityProjectValid = $previewValidation.valid
                }
                Write-Host "  API  GET  /api/config" -ForegroundColor DarkCyan
            }

            # POST /api/config
            elseif ($method -eq 'POST' -and $rawPath -eq '/api/config') {
                $payload = (New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)).ReadToEnd() | ConvertFrom-Json
                $nextLocalFolder = $LocalFolder
                $nextSourceProjectPath = $SourceProjectPath
                $nextPreviewProjectPath = $PreviewProjectPath
                if ($payload.localFolder) {
                    $nextLocalFolder = Resolve-ServerPath ([string]$payload.localFolder)
                    if (-not (Test-Path -LiteralPath $nextLocalFolder)) {
                        New-Item -ItemType Directory -Force -Path $nextLocalFolder | Out-Null
                    }
                }
                if ($payload.PSObject.Properties.Name -contains 'sourceProjectPath') {
                    $candidate = Resolve-ServerPath ([string]$payload.sourceProjectPath)
                    if ($candidate) {
                        $candidateValidation = Get-UnityProjectValidation $candidate
                        Write-UnityProjectValidation 'Source Game Project' $candidateValidation
                        if (-not $candidateValidation.valid) {
                            Throw-UnityProjectValidationError 'source game' $candidateValidation
                        }
                    }
                    $nextSourceProjectPath = $candidate
                }
                $hasPreviewPath = $payload.PSObject.Properties.Name -contains 'previewProjectPath'
                $hasLegacyPath = $payload.PSObject.Properties.Name -contains 'unityProjectPath'
                if ($hasPreviewPath -or $hasLegacyPath) {
                    $previewValue = if ($hasPreviewPath) { $payload.previewProjectPath } else { $payload.unityProjectPath }
                    $candidate = Resolve-ServerPath ([string]$previewValue)
                    if ($candidate) {
                        $candidateValidation = Get-UnityProjectValidation $candidate
                        Write-UnityProjectValidation 'Preview Container' $candidateValidation
                        if (-not $candidateValidation.valid) {
                            Throw-UnityProjectValidationError 'preview container' $candidateValidation
                        }
                    }
                    $nextPreviewProjectPath = $candidate
                }
                if ($nextSourceProjectPath -and $nextPreviewProjectPath -and
                    $nextSourceProjectPath -eq $nextPreviewProjectPath) {
                    throw 'The source game project and preview container must be different folders.'
                }
                $LocalFolder = $nextLocalFolder
                $SourceProjectPath = $nextSourceProjectPath
                $PreviewProjectPath = $nextPreviewProjectPath
                $UnityProjectPath = $PreviewProjectPath
                Save-ServerConfiguration
                $sourceValidation = Get-UnityProjectValidation $SourceProjectPath
                $previewValidation = Get-UnityProjectValidation $PreviewProjectPath
                Send-Json $res @{
                    ok = $true
                    saved = $true
                    apiVersion = 4
                    capabilities = @{
                        projectExtraction = $true
                        projectExtractionStatus = $true
                        separateSourceAndPreview = $true
                        sanitizedParticlePackages = $true
                        multiEffectPackages = $true
                        disposablePreviewWorkspace = $true
                    }
                    localFolder = $LocalFolder
                    sourceProjectPath = $SourceProjectPath
                    sourceProjectValid = $sourceValidation.valid
                    sourceProjectValidation = $sourceValidation
                    previewProjectPath = $PreviewProjectPath
                    previewProjectValid = $previewValidation.valid
                    previewProjectValidation = $previewValidation
                    unityProjectPath = $PreviewProjectPath
                    unityProjectValid = $previewValidation.valid
                }
                Write-Host "  API  POST /api/config" -ForegroundColor DarkCyan
            }

            # POST /api/findfx - source Editor has already exported the active scene.
            elseif ($method -eq 'POST' -and $rawPath -eq '/api/findfx') {
                $body = (New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)).ReadToEnd() | ConvertFrom-Json
                if (-not $body.preExportedPath -or -not $body.sourceProjectPath) {
                    throw 'FindFX requires preExportedPath and sourceProjectPath.'
                }
                $job = Start-ProjectExtractionJob ([string]$body.gameName) ([string]$body.preExportedPath) ([string]$body.sourceProjectPath)
                Send-Json $res @{ ok = $true; job = $job }
            }

            # POST /api/project-extraction
            elseif ($method -eq 'POST' -and $rawPath -eq '/api/project-extraction') {
                $body = (New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)).ReadToEnd()
                $payload = if ($body) { $body | ConvertFrom-Json } else { [pscustomobject]@{} }
                $gameName = if ($payload.PSObject.Properties.Name -contains 'gameName') { $payload.gameName } else { $null }
                $job = Start-ProjectExtractionJob $gameName
                Send-Json $res @{
                    ok = $true
                    jobStarted = $true
                    jobId = $job.jobId
                    sourceProjectPath = $job.sourceProjectPath
                    previewProjectPath = $job.previewProjectPath
                    gameName = $job.gameName
                } 202
                Write-Host "  API  POST /api/project-extraction" -ForegroundColor DarkCyan
            }

            # GET /api/project-extraction-job
            elseif ($method -eq 'GET' -and $rawPath -eq '/api/project-extraction-job') {
                if (Test-Path -LiteralPath $projectJobStatusPath -PathType Leaf) {
                    $status = Get-Content -LiteralPath $projectJobStatusPath -Raw | ConvertFrom-Json
                    if ($projectJobProcess -and $status.state -in @('queued', 'running')) {
                        $projectJobProcess.Refresh()
                        if ($projectJobProcess.HasExited) {
                            $status = Get-Content -LiteralPath $projectJobStatusPath -Raw | ConvertFrom-Json
                            if ($status.state -in @('queued', 'running')) {
                                $status.state = 'failed'
                                $status.phase = 'error'
                                $status.progress = 100
                                $exitDetail = if ($null -ne $projectJobProcess.ExitCode) {
                                    "exit $($projectJobProcess.ExitCode)"
                                } else {
                                    'exit code unavailable'
                                }
                                $status.message = "Extraction worker exited without reporting completion ($exitDetail). Download the log for worker error details."
                                $status.updatedAt = [DateTime]::UtcNow.ToString('o')
                                $status | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $projectJobStatusPath -Encoding UTF8
                            }
                        }
                    }
                    Send-Json $res $status
                } else {
                    Send-Json $res @{
                        state = 'idle'; phase = 'none'; progress = 0
                        message = 'No project extraction job has been started.'
                        exportCount = 0; captureCount = 0; libraryCount = 0; warnings = @()
                    }
                }
            }

            # GET /api/project-extraction-log
            elseif ($method -eq 'GET' -and $rawPath -eq '/api/project-extraction-log') {
                if (-not (Test-Path -LiteralPath $projectJobStatusPath -PathType Leaf)) {
                    Send-Json $res @{ error = 'No extraction log is available. Start an extraction first.' } 404
                } else {
                    $status = Get-Content -LiteralPath $projectJobStatusPath -Raw | ConvertFrom-Json
                    if (-not $status.logPath -or -not (Test-Path -LiteralPath $status.logPath -PathType Leaf)) {
                        Send-Json $res @{ error = 'This job has no diagnostic log. Restart the server and run extraction again.' } 404
                    } else {
                        $logRoot = Split-Path -Parent $status.logPath
                        $logFiles = @(
                            @{ name = 'extraction.log'; label = 'Preparation and extraction steps' }
                            @{ name = 'effects-project-export.log'; label = 'Export - source project Unity log' }
                            @{ name = 'effects-preview-import.log'; label = 'Import - preview workspace Unity log' }
                            @{ name = 'effects-project-capture.log'; label = 'Capture - particle previews Unity log' }
                            @{ name = 'worker-errors.log'; label = 'Worker errors' }
                            @{ name = 'worker-output.log'; label = 'Worker output' }
                        )
                        $isLiveLog = $req.QueryString['format'] -eq 'json'
                        $sections = @(foreach ($logFile in $logFiles) {
                            $name = $logFile.name
                            $path = Join-Path $logRoot $name
                            if (Test-Path -LiteralPath $path -PathType Leaf) {
                                if ($isLiveLog) {
                                    $file = Get-Item -LiteralPath $path
                                    @{
                                        name = $name
                                        label = $logFile.label
                                        content = (Get-Content -LiteralPath $path -Tail 120) -join [Environment]::NewLine
                                        updatedAt = $file.LastWriteTimeUtc.ToString('o')
                                        sizeBytes = $file.Length
                                    }
                                } else {
                                    "===== $name ====="
                                    Get-Content -LiteralPath $path -Raw
                                }
                            }
                        })
                        $res.Headers['Cache-Control'] = 'no-store'
                        if ($isLiveLog) {
                            Send-Json $res @{
                                phase = $status.phase
                                state = $status.state
                                tailLines = 120
                                logs = $sections
                            }
                        } else {
                            $bytes = [Text.Encoding]::UTF8.GetBytes(($sections -join [Environment]::NewLine))
                            $res.StatusCode = 200
                            $res.ContentType = 'text/plain; charset=utf-8'
                            $res.AddHeader('Content-Disposition', 'attachment; filename="effects-extraction-log.txt"')
                            $res.ContentLength64 = $bytes.LongLength
                            $res.OutputStream.Write($bytes, 0, $bytes.Length)
                        }
                    }
                }
            }

            # POST /api/save-effects
            elseif ($method -eq 'POST' -and $rawPath -eq '/api/save-effects') {
                $payload = (New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)).ReadToEnd() | ConvertFrom-Json
                $payload.manifest | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $LocalFolder 'manifest.json') -Encoding UTF8
                $saved = 0
                foreach ($file in $payload.files) {
                    $dest = Join-Path $LocalFolder ($file.path -replace '/', [IO.Path]::DirectorySeparatorChar)
                    $dir  = Split-Path $dest -Parent
                    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
                    [IO.File]::WriteAllText($dest, $file.content, [Text.Encoding]::UTF8)
                    $saved++
                }
                Send-Json $res @{ ok = $true; files = $saved; localFolder = $LocalFolder }
                Write-Host "  API  POST /api/save-effects  ($saved files)" -ForegroundColor Green
            }

            # POST /api/delete-effect
            elseif ($method -eq 'POST' -and $rawPath -eq '/api/delete-effect') {
                $body = (New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)).ReadToEnd()
                $payload = if ($body) { $body | ConvertFrom-Json } else { [pscustomobject]@{} }
                $effectId = [string]$payload.id
                $effectOriginalPath = [string]$payload.originalPath
                $effectName = [string]$payload.name
                $effectType = [string]$payload.type
                $effectGame = [string]$payload.game
                if (-not $effectId -and -not $effectOriginalPath -and -not $effectName) {
                    Send-Json $res @{ ok = $false; error = 'Effect identity is required.' } 400
                } else {
                    $manifestPath = Join-Path $LocalFolder 'manifest.json'
                    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
                        Send-Json $res @{ ok = $false; error = 'Local manifest.json was not found.' } 404
                    } else {
                        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
                        $effects = @($manifest.effects)
                        $target = $null
                        if ($effectId) {
                            $target = $effects | Where-Object { $_.id -eq $effectId } | Select-Object -First 1
                        }
                        if (-not $target -and $effectOriginalPath) {
                            $target = $effects | Where-Object { $_.originalPath -eq $effectOriginalPath } | Select-Object -First 1
                        }
                        if (-not $target -and $effectName) {
                            $target = $effects | Where-Object {
                                $_.name -eq $effectName -and
                                ((-not $effectType) -or $_.type -eq $effectType) -and
                                ((-not $effectGame) -or $_.game -eq $effectGame)
                            } | Select-Object -First 1
                        }
                        if (-not $target) {
                            Send-Json $res @{ ok = $false; error = 'Effect was not found.' } 404
                        } else {
                            $removedFiles = 0
                            $toDelete = @()
                            if ($target.files) {
                                foreach ($path in @($target.files.main, $target.files.package, $target.files.thumbnail)) {
                                    if ($path) { $toDelete += [string]$path }
                                }
                            }
                            if ($target.packageFile) {
                                $toDelete += "packages/$([string]$target.packageFile)"
                            }
                            $toDelete = @($toDelete | Select-Object -Unique)
                            foreach ($relPath in $toDelete) {
                                $clean = ($relPath -replace '\\', '/').TrimStart('/')
                                if (-not $clean) { continue }
                                $candidate = [IO.Path]::GetFullPath((Join-Path $LocalFolder ($clean -replace '/', [IO.Path]::DirectorySeparatorChar)))
                                $localRoot = [IO.Path]::GetFullPath($LocalFolder).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
                                if ($candidate.StartsWith($localRoot, [StringComparison]::OrdinalIgnoreCase) -and
                                    (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                                    Remove-Item -LiteralPath $candidate -Force
                                    $removedFiles++
                                }
                            }

                            $targetKey = if ($target.id) { [string]$target.id } else { [string]$target.originalPath }
                            if ($target.id) {
                                $manifest.effects = @($effects | Where-Object { $_.id -ne $target.id })
                            } elseif ($target.originalPath) {
                                $manifest.effects = @($effects | Where-Object { $_.originalPath -ne $target.originalPath })
                            } else {
                                $removedOnce = $false
                                $manifest.effects = @($effects | Where-Object {
                                    if (-not $removedOnce -and $_.name -eq $target.name -and $_.type -eq $target.type -and $_.game -eq $target.game) {
                                        $removedOnce = $true
                                        return $false
                                    }
                                    return $true
                                })
                            }
                            $manifest.generatedAt = [DateTime]::UtcNow.ToString('o')
                            $manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
                            Send-Json $res @{ ok = $true; id = $target.id; removedKey = $targetKey; removedFiles = $removedFiles }
                            Write-Host "  API  POST /api/delete-effect  ($targetKey, files=$removedFiles)" -ForegroundColor Green
                        }
                    }
                }
            }

            # POST /api/delete-game
            elseif ($method -eq 'POST' -and $rawPath -eq '/api/delete-game') {
                $body = (New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)).ReadToEnd()
                $payload = if ($body) { $body | ConvertFrom-Json } else { [pscustomobject]@{} }
                $gameName = [string]$payload.game
                if (-not $gameName) {
                    Send-Json $res @{ ok = $false; error = 'Game name is required.' } 400
                } else {
                    $manifestPath = Join-Path $LocalFolder 'manifest.json'
                    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
                        Send-Json $res @{ ok = $false; error = 'Local manifest.json was not found.' } 404
                    } else {
                        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
                        $effects = @($manifest.effects)
                        $targets = @($effects | Where-Object { [string]$_.game -eq $gameName })
                        if ($targets.Count -eq 0) {
                            Send-Json $res @{ ok = $false; error = "No effects found for game '$gameName'." } 404
                        } else {
                            $removedFiles = 0
                            $localRoot = [IO.Path]::GetFullPath($LocalFolder).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
                            foreach ($target in $targets) {
                                $toDelete = @()
                                if ($target.files) {
                                    foreach ($p in @($target.files.main, $target.files.package, $target.files.thumbnail)) {
                                        if ($p) { $toDelete += [string]$p }
                                    }
                                }
                                if ($target.packageFile) { $toDelete += "packages/$([string]$target.packageFile)" }
                                foreach ($relPath in @($toDelete | Select-Object -Unique)) {
                                    $clean = ($relPath -replace '\\', '/').TrimStart('/')
                                    if (-not $clean) { continue }
                                    $candidate = [IO.Path]::GetFullPath((Join-Path $LocalFolder ($clean -replace '/', [IO.Path]::DirectorySeparatorChar)))
                                    if ($candidate.StartsWith($localRoot, [StringComparison]::OrdinalIgnoreCase) -and
                                        (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                                        Remove-Item -LiteralPath $candidate -Force
                                        $removedFiles++
                                    }
                                }
                            }
                            $manifest.effects = @($effects | Where-Object { [string]$_.game -ne $gameName })
                            $manifest.generatedAt = [DateTime]::UtcNow.ToString('o')
                            $manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
                            Send-Json $res @{ ok = $true; game = $gameName; deleted = $targets.Count; removedFiles = $removedFiles }
                            Write-Host "  API  POST /api/delete-game  ($gameName, deleted=$($targets.Count), files=$removedFiles)" -ForegroundColor Green
                        }
                    }
                }
            }

            # POST /api/upload-package
            elseif ($method -eq 'POST' -and $rawPath -eq '/api/upload-package') {
                $rawName  = $req.Headers['X-Filename']
                $filename = if ($rawName) { [Uri]::UnescapeDataString($rawName) } else { 'package.unitypackage' }
                if (-not $filename.EndsWith('.unitypackage', [StringComparison]::OrdinalIgnoreCase)) {
                    Send-Json $res @{ ok = $false; error = 'Only .unitypackage files are accepted.' } 400
                } else {
                    $importDir = if ($UnityProjectPath) { Join-Path $UnityProjectPath 'Assets\ImportedPackages' } else { Join-Path $LocalFolder 'ImportedPackages' }
                    if (-not (Test-Path $importDir)) { New-Item -ItemType Directory -Force -Path $importDir | Out-Null }
                    $savePath = Join-Path $importDir $filename
                    $ms = [IO.MemoryStream]::new()
                    $req.InputStream.CopyTo($ms)
                    [IO.File]::WriteAllBytes($savePath, $ms.ToArray())
                    $mb = [math]::Round($ms.Length / 1MB, 1)
                    $lastUploadedPackage = $savePath
                    if ($UnityProjectPath) {
                        Start-PackageJob $savePath
                        Send-Json $res @{ ok = $true; path = $savePath; filename = $filename; sizeMb = $mb; jobStarted = $true }
                    } else {
                        Send-Json $res @{ ok = $true; path = $savePath; filename = $filename; sizeMb = $mb; jobStarted = $false; warning = 'Configure Unity Project Path to run automatic import and capture.' }
                    }
                    Write-Host "  PKG  $filename ($mb MB) -> $savePath" -ForegroundColor Cyan
                }
            }

            # GET /api/package-job
            elseif ($method -eq 'GET' -and $rawPath -eq '/api/package-job') {
                if (Test-Path -LiteralPath $packageJobStatusPath) {
                    $status = Get-Content -LiteralPath $packageJobStatusPath -Raw | ConvertFrom-Json
                    Send-Json $res $status
                } else {
                    Send-Json $res @{ state = 'idle'; phase = 'none'; progress = 0; message = 'No package job has been started.' }
                }
            }

            # GET /api/captures
            elseif ($method -eq 'GET' -and $rawPath -eq '/api/captures') {
                $capDir = if ($UnityProjectPath) { Join-Path (Split-Path $UnityProjectPath -Parent) 'ThumbnailCaptures' } else { Join-Path $LocalFolder 'ThumbnailCaptures' }
                if (Test-Path $capDir) {
                    $files = (Get-ChildItem $capDir -Filter '*.png').Name
                    Send-Json $res @{ ok = $true; folder = $capDir; count = @($files).Count; files = @($files) }
                } else {
                    Send-Json $res @{ ok = $false; folder = $capDir; count = 0; files = @() }
                }
                Write-Host "  API  GET  /api/captures" -ForegroundColor DarkCyan
            }

            # GET /api/unity-asset?path=Assets/... (download an imported Unity asset)
            elseif ($method -eq 'GET' -and $rawPath -eq '/api/unity-asset') {
                $assetPath = $req.QueryString['path']
                if (-not $UnityProjectPath -or -not $assetPath) {
                    Send-Json $res @{ ok = $false; error = 'Unity project and asset path are required.' } 400
                } else {
                    $assetsRoot = [IO.Path]::GetFullPath((Join-Path $UnityProjectPath 'Assets')).TrimEnd('\')
                    $requestedAsset = [IO.Path]::GetFullPath((Join-Path $UnityProjectPath ($assetPath -replace '/', '\')))
                    $assetsPrefix = $assetsRoot + '\'
                    if (-not $requestedAsset.StartsWith($assetsPrefix, [StringComparison]::OrdinalIgnoreCase) -or
                        -not (Test-Path -LiteralPath $requestedAsset -PathType Leaf)) {
                        Send-Json $res @{ ok = $false; error = 'Unity asset was not found or is outside the Assets folder.' } 404
                    } else {
                        Serve-Download $res $requestedAsset $rawPath
                    }
                }
            }

            # GET /api/unity-package?name=... or ?assetPath=Assets/...
            elseif ($method -eq 'GET' -and $rawPath -eq '/api/unity-package') {
                $packageName = $req.QueryString['name']
                $assetPath = $req.QueryString['assetPath']
                $package = $null
                if ($packageName -and $UnityProjectPath -and [IO.Path]::GetFileName($packageName) -eq $packageName) {
                    $candidate = Join-Path $UnityProjectPath (Join-Path 'Assets\ImportedPackages' $packageName)
                    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $package = Get-Item -LiteralPath $candidate }
                } elseif ($assetPath) {
                    $package = Find-UnityPackageForAsset $assetPath
                }

                if (-not $package) {
                    Send-Json $res @{ ok = $false; error = 'The original Unity package could not be found.' } 404
                } else {
                    Serve-Download $res $package.FullName $rawPath
                }
            }

            # POST /api/import-captures
            elseif ($method -eq 'POST' -and $rawPath -eq '/api/import-captures') {
                $capDir = if ($UnityProjectPath) { Join-Path (Split-Path $UnityProjectPath -Parent) 'ThumbnailCaptures' } else { Join-Path $LocalFolder 'ThumbnailCaptures' }
                if (-not (Test-Path $capDir)) {
                    Send-Json $res @{ ok = $false; error = "Captures folder not found: $capDir. Run Effects Extractor > Capture Thumbnails in Unity first." } 404
                } else {
                    $manifestPath = Join-Path $LocalFolder 'manifest.json'
                    $manifest = if (Test-Path $manifestPath) {
                        Get-Content $manifestPath -Raw | ConvertFrom-Json
                    } else {
                        [pscustomobject]@{ version = '1.0.0'; generatedAt = [DateTime]::UtcNow.ToString('o'); effects = @() }
                    }
                    $captureManifestPath = Join-Path $capDir 'capture-manifest.json'
                    $captureEntries = if (Test-Path $captureManifestPath) {
                        @((Get-Content $captureManifestPath -Raw | ConvertFrom-Json).captures)
                    } else { @() }
                    $thumbDir = Join-Path $LocalFolder 'thumbnails'
                    if (-not (Test-Path $thumbDir)) { New-Item -ItemType Directory -Force -Path $thumbDir | Out-Null }
                    $imported = 0; $skipped = 0
                    foreach ($png in (Get-ChildItem $capDir -Filter '*.png')) {
                        $stem   = [IO.Path]::GetFileNameWithoutExtension($png.Name)
                        $effect = $null
                        $capture = $captureEntries | Where-Object { $_.thumbnail -ieq $png.Name } | Select-Object -First 1
                        $captureType = if ($capture -and $capture.effectType) { $capture.effectType } else { 'particle' }
                        $packageMatch = if ($capture) { Find-UnityPackageForAsset $capture.assetPath } else { $null }
                        if ($capture -and $manifest -and $manifest.effects) {
                            $effect = $manifest.effects | Where-Object { $_.originalPath -ieq $capture.assetPath } | Select-Object -First 1
                        } elseif ($manifest -and $manifest.effects) {
                            $effect = $manifest.effects | Where-Object { [IO.Path]::GetFileNameWithoutExtension($_.originalPath) -ieq $stem } | Select-Object -First 1
                        }
                        if (-not $effect) {
                            if ($capture) {
                                $slug = ($capture.name.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
                                $hashBytes = [Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($capture.assetPath))
                                $hash = -join ($hashBytes[0..3] | ForEach-Object { $_.ToString('x2') })
                                $effect = [pscustomobject]@{
                                    id = "$slug-unity-$hash"
                                    name = $capture.name
                                    type = $captureType
                                    game = Split-Path $UnityProjectPath -Leaf
                                    importSource = 'manual-upload'
                                    packageFile = if ($packageMatch) { $packageMatch.Name } else { $null }
                                    originalPath = $capture.assetPath
                                    files = [pscustomobject]@{ main = $null; thumbnail = $null }
                                    metadata = $capture.metadata
                                    tags = @($captureType, (Split-Path $UnityProjectPath -Leaf), 'uploaded')
                                    extractedAt = [DateTime]::UtcNow.ToString('o')
                                }
                                $manifest.effects = @($manifest.effects) + $effect
                            }
                        }
                        elseif ($capture) {
                            $effect.name = $capture.name
                            $effect.type = $captureType
                            $effect | Add-Member -NotePropertyName importSource -NotePropertyValue 'manual-upload' -Force
                            $effect | Add-Member -NotePropertyName packageFile -NotePropertyValue $(if ($packageMatch) { $packageMatch.Name } else { $null }) -Force
                            $effect.originalPath = $capture.assetPath
                            $effect.metadata = $capture.metadata
                            $effect.tags = @($effect.type, (Split-Path $UnityProjectPath -Leaf), 'uploaded')
                            $effect.extractedAt = [DateTime]::UtcNow.ToString('o')
                        }
                        if ($effect) {
                            $destName = $effect.id + '.png'
                            Copy-Item $png.FullName (Join-Path $thumbDir $destName) -Force
                            $effect.files.thumbnail = "thumbnails/$destName"
                            $imported++
                        } else { $skipped++ }
                    }
                    if ($manifest -and $imported -gt 0) {
                        $manifest.generatedAt = [DateTime]::UtcNow.ToString('o')
                        $manifest | ConvertTo-Json -Depth 20 | Set-Content $manifestPath -Encoding UTF8
                    }
                    Send-Json $res @{ ok = $true; imported = $imported; skipped = $skipped; folder = $capDir }
                    Write-Host "  CAP  Imported=$imported Skipped=$skipped" -ForegroundColor Green
                }
            }

            # GET /local/*
            elseif ($method -eq 'GET' -and $rawPath.StartsWith('/local/')) {
                $rel      = ($rawPath.Substring(7)) -replace '/', [IO.Path]::DirectorySeparatorChar
                $filePath = Join-Path $LocalFolder $rel
                if (Test-Path $filePath -PathType Leaf) {
                    Serve-File $res $filePath $rawPath
                } else {
                    $body = [Text.Encoding]::UTF8.GetBytes("Not found: $rawPath")
                    $res.StatusCode = 404; $res.ContentType = 'text/plain'; $res.ContentLength64 = $body.LongLength
                    $res.OutputStream.Write($body, 0, $body.Length)
                    Write-Host "  404  $rawPath" -ForegroundColor Yellow
                }
            }

            # Static webapp files
            else {
                $rel      = $rawPath.TrimStart('/').Replace('/', [IO.Path]::DirectorySeparatorChar)
                if ($rel -eq '') { $rel = 'index.html' }
                $filePath = Join-Path $webRoot $rel
                if (Test-Path $filePath -PathType Leaf) {
                    Serve-File $res $filePath $rawPath
                } else {
                    $indexPath = Join-Path $webRoot 'index.html'
                    if (([IO.Path]::GetExtension($rel) -eq '') -and (Test-Path $indexPath)) {
                        Serve-File $res $indexPath $rawPath
                    } else {
                        $body = [Text.Encoding]::UTF8.GetBytes("404 Not Found")
                        $res.StatusCode = 404; $res.ContentType = 'text/plain'; $res.ContentLength64 = $body.LongLength
                        $res.OutputStream.Write($body, 0, $body.Length)
                        Write-Host "  404  $rawPath" -ForegroundColor Yellow
                    }
                }
            }
        } catch {
            Write-Host "  ERR  $rawPath : $_" -ForegroundColor Red
            try {
                if ($res.OutputStream.CanWrite) {
                    $statusCode = 500
                    $errorPayload = @{ ok = $false; error = $_.Exception.Message }
                    if ($_.Exception.Data['logAvailable']) {
                        $errorPayload['logAvailable'] = $true
                    }
                    $validationJson = $_.Exception.Data['validationJson']
                    if ($validationJson) {
                        $errorPayload['validation'] = $validationJson | ConvertFrom-Json
                    }
                    if ($_.Exception.Data['statusCode']) {
                        $statusCode = [int]$_.Exception.Data['statusCode']
                    }
                    Send-Json $res $errorPayload $statusCode
                }
            } catch {
                try { $res.StatusCode = 500 } catch {}
            }
        } finally {
            try { $res.OutputStream.Close() } catch {}
        }
    }
} finally {
    try { $listener.Stop() } catch {}
    Write-Host "  Server stopped." -ForegroundColor DarkGray
}
