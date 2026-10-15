$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'Tools~\encode-previews.ps1')
$testRoot = Join-Path $repo ('outputs\gif-test-' + [Guid]::NewGuid().ToString('N'))
$frames = Join-Path $testRoot 'test-frames'
New-Item -ItemType Directory -Force -Path $frames | Out-Null
$encoderRoot = Join-Path $repo 'Tools~\ThirdParty\ffmpeg'
$encoder = Join-Path $encoderRoot 'bin\ffmpeg.exe'
if (-not (Test-Path -LiteralPath $encoder)) {
    Expand-Archive -LiteralPath (Join-Path $encoderRoot 'ffmpeg.zip') -DestinationPath (Join-Path $encoderRoot 'bin') -Force
}
& $encoder -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=size=160x90:rate=24:duration=3' `
    -frames:v 72 -start_number 0 (Join-Path $frames '%03d.png')
if ($LASTEXITCODE -ne 0) { throw 'Test frame generation failed.' }
@{ captures = @(@{ name = 'test'; frames = 'test-frames'; thumbnail = 'test.gif' }) } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $testRoot 'capture-manifest.json') -Encoding UTF8
ConvertTo-GifPreviews $testRoot
Add-Type -AssemblyName System.Drawing
$image = [Drawing.Image]::FromFile((Join-Path $testRoot 'test.gif'))
try {
    if ($image.GetFrameCount([Drawing.Imaging.FrameDimension]::Time) -ne 72) { throw 'Expected 72 GIF frames.' }
    $delays = $image.GetPropertyItem(0x5100).Value
    $duration = 0
    for ($index = 0; $index -lt 72; $index++) {
        $delay = [BitConverter]::ToUInt32($delays, $index * 4)
        if ($delay -notin @(4, 5)) { throw "Unexpected frame delay: $delay" }
        $duration += $delay
    }
    if ($duration -ne 300) { throw "Expected 300 centiseconds, got $duration." }
    if ([BitConverter]::ToUInt16($image.GetPropertyItem(0x5101).Value, 0) -ne 0) { throw 'GIF must loop indefinitely.' }
    if (Test-Path -LiteralPath $frames) { throw 'Temporary frames were not removed.' }
} finally { $image.Dispose() }
Write-Host "PASS: 72 GIF frames, 3 seconds, infinite loop, temporary frame cleanup. $testRoot"
