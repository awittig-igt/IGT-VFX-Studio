$ErrorActionPreference = 'Stop'

function ConvertTo-GifPreviews {
    param([Parameter(Mandatory = $true)][string]$CapturePath)
    $encoder = Join-Path $PSScriptRoot 'ThirdParty\ffmpeg\bin\ffmpeg.exe'
    if (-not (Test-Path -LiteralPath $encoder)) {
        $bundle = Join-Path $PSScriptRoot 'ThirdParty\ffmpeg\ffmpeg.zip'
        if (Test-Path -LiteralPath $bundle) {
            Expand-Archive -LiteralPath $bundle -DestinationPath (Split-Path -Parent $encoder) -Force
        }
    }
    if (-not (Test-Path -LiteralPath $encoder -PathType Leaf)) {
        throw 'The bundled FFmpeg encoder is missing. Reinstall the complete FindFX package.'
    }
    if ((Get-FileHash -LiteralPath $encoder -Algorithm SHA256).Hash -ne '1326DDE4C84FF1F96FE6B8916C5BED29E163E9B5DCCF995F6F3DB069D143EC5E') {
        throw 'The bundled FFmpeg encoder failed its integrity check. Reinstall the complete FindFX package.'
    }
    $root = [IO.Path]::GetFullPath($CapturePath).TrimEnd('\') + '\'
    $manifestPath = Join-Path $root 'capture-manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    foreach ($capture in $manifest.captures) {
        if (-not $capture.frames -or [IO.Path]::GetFileName($capture.frames) -ne $capture.frames -or
            [IO.Path]::GetFileName($capture.thumbnail) -ne $capture.thumbnail -or
            [IO.Path]::GetExtension($capture.thumbnail) -ne '.gif') {
            throw 'Invalid animation paths in capture manifest.'
        }
        $frames = [IO.Path]::GetFullPath((Join-Path $root $capture.frames))
        if (-not $frames.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe frame directory.' }
        for ($index = 0; $index -lt 72; $index++) {
            if (-not (Test-Path -LiteralPath (Join-Path $frames ('{0:D3}.png' -f $index)))) {
                throw "Missing frame $index for $($capture.name)."
            }
        }
        $pattern = Join-Path $frames '%03d.png'
        $palette = Join-Path $frames 'palette.png'
        $gif = Join-Path $root $capture.thumbnail
        $log = Join-Path $frames 'encoding.log'
        & $encoder -hide_banner -loglevel error -y -framerate 24 -start_number 0 -i $pattern `
            -vf 'palettegen=stats_mode=full' -frames:v 1 $palette 2> $log
        if ($LASTEXITCODE -ne 0) { throw "GIF palette generation failed for $($capture.name). See $log" }
        # GIF timestamps use centiseconds. Quantize the 24 FPS timeline, with
        # a 4 cs final delay, to retain all 72 frames and exactly 300 cs total.
        & $encoder -hide_banner -loglevel error -y -framerate 24 -start_number 0 -i $pattern -i $palette `
            -lavfi 'paletteuse=dither=sierra2_4a' -frames:v 72 -fps_mode passthrough -loop 0 -final_delay 4 $gif 2>> $log
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $gif)) {
            throw "GIF encoding failed for $($capture.name). See $log"
        }
        Remove-Item -LiteralPath $frames -Recurse -Force
    }
}
