param([Parameter(Mandatory=$true)][string]$InputJson)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
$taskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function AwaitResult($operation, [Type]$resultType) {
    $task = $taskMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))
    return $task.GetAwaiter().GetResult()
}
$request = Get-Content -LiteralPath $InputJson -Raw -Encoding UTF8 | ConvertFrom-Json
$language = New-Object Windows.Globalization.Language($request.language)
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
if ($null -eq $engine) { throw "Windows OCR language unavailable: $($request.language)" }
$results = @()
foreach ($entry in $request.frames) {
    $file = AwaitResult ([Windows.Storage.StorageFile]::GetFileFromPathAsync($entry.file)) ([Windows.Storage.StorageFile])
    $stream = AwaitResult ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = AwaitResult ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = AwaitResult ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        try {
            $ocr = AwaitResult ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            $items = @()
            foreach ($line in $ocr.Lines) {
                $left = [double]::PositiveInfinity; $top = [double]::PositiveInfinity
                $right = 0.0; $bottom = 0.0
                foreach ($word in $line.Words) {
                    $box = $word.BoundingRect
                    $left = [Math]::Min($left, $box.X); $top = [Math]::Min($top, $box.Y)
                    $right = [Math]::Max($right, $box.X + $box.Width)
                    $bottom = [Math]::Max($bottom, $box.Y + $box.Height)
                }
                if ($line.Words.Count -gt 0) {
                    $items += @{text=$line.Text; box=@(($left/$bitmap.PixelWidth), ($top/$bitmap.PixelHeight),
                        (($right-$left)/$bitmap.PixelWidth), (($bottom-$top)/$bitmap.PixelHeight))}
                }
            }
            $results += @{t=$entry.t; items=$items}
        } finally { $bitmap.Dispose() }
    } finally { $stream.Dispose() }
}
ConvertTo-Json -InputObject @{engine='windows-media-ocr'; language=$request.language; frames=$results} -Depth 8 -Compress
