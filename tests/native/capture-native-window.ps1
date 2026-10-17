param(
    [Parameter(Mandatory = $true)][int]$TargetProcessId,
    [Parameter(Mandatory = $true)][string]$WindowHandle,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [ValidateRange(1, 16)][int]$SampleStep = 1
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SlateScreenProbe {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr handle);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr handle, IntPtr context);
    [DllImport("gdi32.dll", SetLastError = true)] public static extern bool BitBlt(IntPtr target, int tx, int ty, int width, int height, IntPtr source, int sx, int sy, uint operation);
}
'@
[void][SlateScreenProbe]::SetProcessDPIAware()
$handleValue = [IntPtr]([Convert]::ToInt64($WindowHandle.Replace('0x', ''), 16))
[uint32]$owner = 0
[void][SlateScreenProbe]::GetWindowThreadProcessId($handleValue, [ref]$owner)
if ($owner -ne $TargetProcessId) { throw 'The window does not belong to the verified application process.' }
$rect = New-Object SlateScreenProbe+Rect
if (![SlateScreenProbe]::GetWindowRect($handleValue, [ref]$rect)) { throw 'The application window no longer exists.' }
$width = $rect.right - $rect.left
$height = $rect.bottom - $rect.top
if ($width -le 0 -or $height -le 0 -or $width -gt 8192 -or $height -gt 8192) { throw 'Invalid application window bounds.' }
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $screenContext = [SlateScreenProbe]::GetDC([IntPtr]::Zero)
    $targetContext = $graphics.GetHdc()
    try {
        # SRCCOPY | CAPTUREBLT includes the actual layered-window composition.
        if (![SlateScreenProbe]::BitBlt($targetContext, 0, 0, $width, $height, $screenContext, $rect.left, $rect.top, [uint32]0x40CC0020)) { throw 'Cannot capture the application window from the screen.' }
    } finally {
        $graphics.ReleaseHdc($targetContext)
        [void][SlateScreenProbe]::ReleaseDC([IntPtr]::Zero, $screenContext)
    }
    $bitmap.Save([System.IO.Path]::GetFullPath($OutputPath), [System.Drawing.Imaging.ImageFormat]::Png)
    $greenPixels = 0
    for ($y = 0; $y -lt $height; $y += $SampleStep) {
        for ($x = 0; $x -lt $width; $x += $SampleStep) {
            $color = $bitmap.GetPixel($x, $y)
            if ($color.G -ge 130 -and $color.G -gt ($color.R * 1.45) -and $color.G -gt ($color.B * 1.2)) { $greenPixels++ }
        }
    }
    ConvertTo-Json -InputObject @{ processId = $owner; isVisible = [SlateScreenProbe]::IsWindowVisible($handleValue); x = $rect.left; y = $rect.top; width = $width; height = $height; greenPixels = $greenPixels; sampleStep = $SampleStep } -Compress
} finally { $graphics.Dispose(); $bitmap.Dispose() }
