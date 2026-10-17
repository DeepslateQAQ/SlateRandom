param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$TargetProcessId,
    [Parameter(Mandatory = $true)][string]$WindowHandle,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [ValidateRange(-2000, 2000)][int]$MoveX = -160,
    [ValidateRange(-1000, 1000)][int]$MoveY = 80,
    [ValidateRange(8, 120)][int]$Steps = 32,
    [ValidateRange(12, 100)][int]$StepMilliseconds = 24,
    [ValidateRange(0, 6000)][int]$StationaryMilliseconds = 3200
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# The path is restricted to one verified HWND. No mouse input or other window is
# activated. All coordinates in the report and injection are physical pixels.
# API contract: https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-injecttouchinput
if (-not ('SlateRandom.Diagnostics.NativeTouch' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace SlateRandom.Diagnostics {
    [StructLayout(LayoutKind.Sequential)] public struct TouchPoint { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] public struct TouchRect { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] internal struct PointerInfo {
        public uint pointerType, pointerId, frameId, pointerFlags;
        public IntPtr sourceDevice, hwndTarget;
        public TouchPoint ptPixelLocation, ptHimetricLocation, ptPixelLocationRaw, ptHimetricLocationRaw;
        public uint dwTime, historyCount;
        public int inputData;
        public uint dwKeyStates;
        public ulong performanceCount;
        public uint buttonChangeType;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct PointerTouchInfo {
        public PointerInfo pointerInfo;
        public uint touchFlags, touchMask;
        public TouchRect rcContact, rcContactRaw;
        public uint orientation, pressure;
    }
    public sealed class TouchSample {
        public string phase;
        public long elapsedMilliseconds;
        public long beforeAt, at;
        public int inputX, inputY;
        public TouchPoint cursor;
        public bool cursorAvailable;
        public TouchRect window;
        public bool visible;
    }
    public sealed class TouchInput {
        public string phase;
        public long beforeAt, at, elapsedMilliseconds;
        public int inputX, inputY;
    }
    public sealed class TouchReport {
        public bool success, initialized, pointerDown, contactReleased = true;
        public string error, releaseError, hwnd;
        public int? nativeErrorCode, hResult, releaseNativeErrorCode, releaseHResult;
        public uint processId;
        public int pointerInfoBytes, pointerTouchInfoBytes;
        public TouchRect initialWindow;
        public List<TouchSample> samples = new List<TouchSample>();
        public List<TouchInput> inputs = new List<TouchInput>();
    }
    public static class NativeTouch {
        private const uint Down = 0x00010000, Update = 0x00020000, Up = 0x00040000;
        private const uint InRange = 0x00000002, InContact = 0x00000004;
        [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool InitializeTouchInjection(uint maxCount, uint mode);
        [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool InjectTouchInput(uint count, [In, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] PointerTouchInfo[] contacts);
        [DllImport("user32.dll", SetLastError = true)] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
        [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetWindowRect(IntPtr hwnd, out TouchRect rect);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsChild(IntPtr parent, IntPtr child);
        [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(TouchPoint point);
        [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetCursorPos(out TouchPoint point);
        [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetProcessDPIAware();

        private static void Send(ref PointerTouchInfo contact, uint flags, int x, int y) {
            contact.pointerInfo.pointerFlags = flags;
            contact.pointerInfo.ptPixelLocation = new TouchPoint { x = x, y = y };
            contact.rcContact = new TouchRect { left = x - 2, top = y - 2, right = x + 2, bottom = y + 2 };
            // System timestamps avoid equal custom performance-counter timestamps.
            // ERROR_NOT_READY is explicitly retryable for the same touch frame.
            for (int attempt = 0; attempt < 10; attempt++) {
                if (InjectTouchInput(1, new PointerTouchInfo[] { contact })) return;
                int error = Marshal.GetLastWin32Error();
                if (error != 21 || attempt == 9) throw new Win32Exception(error, "InjectTouchInput failed (Win32 " + error + ": " + new Win32Exception(error).Message + "; flags=0x" + flags.ToString("X") + "; x=" + x + "; y=" + y + ").");
                Thread.Sleep(2);
            }
        }
        private static long Now() { return (DateTime.UtcNow.Ticks - 621355968000000000L) / TimeSpan.TicksPerMillisecond; }
        private static void RecordSend(TouchReport report, Stopwatch timer, ref PointerTouchInfo contact, string phase, uint flags, int x, int y) {
            long beforeAt = Now();
            Send(ref contact, flags, x, y);
            report.inputs.Add(new TouchInput { phase = phase, beforeAt = beforeAt, at = Now(),
                elapsedMilliseconds = timer.ElapsedMilliseconds, inputX = x, inputY = y });
        }
        private static void Sample(TouchReport report, IntPtr hwnd, Stopwatch timer, string phase, int x, int y) {
            long beforeAt = Now();
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            TouchRect rect;
            if (owner != report.processId || !GetWindowRect(hwnd, out rect)) throw new InvalidOperationException("The verified target HWND disappeared during touch injection.");
            TouchPoint cursor;
            bool cursorAvailable = GetCursorPos(out cursor);
            report.samples.Add(new TouchSample { phase = phase, elapsedMilliseconds = timer.ElapsedMilliseconds,
                beforeAt = beforeAt, at = Now(), inputX = x, inputY = y, cursor = cursor, cursorAvailable = cursorAvailable,
                window = rect, visible = IsWindowVisible(hwnd) });
        }
        public static TouchReport Run(uint targetProcessId, long handle, int moveX, int moveY, int steps, int stepMilliseconds, int stationaryMilliseconds) {
            TouchReport report = new TouchReport { processId = targetProcessId, hwnd = "0x" + handle.ToString("X"),
                pointerInfoBytes = Marshal.SizeOf(typeof(PointerInfo)), pointerTouchInfoBytes = Marshal.SizeOf(typeof(PointerTouchInfo)) };
            IntPtr hwnd = new IntPtr(handle), previousDpi = IntPtr.Zero;
            PointerTouchInfo contact = new PointerTouchInfo();
            int lastX = 0, lastY = 0;
            Stopwatch timer = Stopwatch.StartNew();
            try {
                try { previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4)); }
                catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
                uint owner;
                GetWindowThreadProcessId(hwnd, out owner);
                if (owner != targetProcessId) throw new InvalidOperationException("The target HWND does not belong to the verified application process.");
                TouchRect rect;
                if (!GetWindowRect(hwnd, out rect) || !IsWindowVisible(hwnd)) throw new InvalidOperationException("The target window is unavailable or hidden.");
                if (rect.right - rect.left < 16 || rect.right - rect.left > 600 || rect.bottom - rect.top < 16 || rect.bottom - rect.top > 600)
                    throw new InvalidOperationException("The target must be the small, visible floating-ball window.");
                report.initialWindow = rect;
                lastX = rect.left + (rect.right - rect.left) / 2;
                lastY = rect.top + (rect.bottom - rect.top) / 2;
                IntPtr hit = WindowFromPoint(new TouchPoint { x = lastX, y = lastY });
                if (hit != hwnd && !IsChild(hwnd, hit)) throw new InvalidOperationException("Another window covers the verified touch-down point; refusing to inject into it.");
                int virtualX = GetSystemMetrics(76), virtualY = GetSystemMetrics(77);
                int virtualRight = virtualX + GetSystemMetrics(78), virtualBottom = virtualY + GetSystemMetrics(79);
                if (lastX + moveX < virtualX || lastX + moveX >= virtualRight || lastY + moveY < virtualY || lastY + moveY >= virtualBottom)
                    throw new InvalidOperationException("The requested touch path leaves the physical desktop.");
                if (!InitializeTouchInjection(1, 3)) throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeTouchInjection is unavailable or denied.");
                report.initialized = true;
                contact.pointerInfo.pointerType = 2; // PT_TOUCH
                contact.pointerInfo.pointerId = 0; // The single declared injection contact is slot zero (SDK sample).
                contact.touchMask = 7; // CONTACTAREA | ORIENTATION | PRESSURE
                contact.orientation = 90;
                contact.pressure = 512; // Documented normalized range: 0..1024.
                RecordSend(report, timer, ref contact, "down", Down | InRange | InContact, lastX, lastY);
                report.pointerDown = true;
                report.contactReleased = false;
                Thread.Sleep(40);
                Sample(report, hwnd, timer, "down", lastX, lastY);
                int startX = lastX, startY = lastY;
                for (int step = 1; step <= steps; step++) {
                    int x = startX + (int)Math.Round((double)moveX * step / steps);
                    int y = startY + (int)Math.Round((double)moveY * step / steps);
                    RecordSend(report, timer, ref contact, "move", Update | InRange | InContact, x, y);
                    lastX = x; lastY = y;
                    Thread.Sleep(stepMilliseconds);
                    Sample(report, hwnd, timer, "move", lastX, lastY);
                }
                // Keep the contact down longer than the quit hold threshold. A
                // drag must never become a long press, even once motion stops.
                int remaining = stationaryMilliseconds;
                while (remaining > 0) {
                    int wait = Math.Min(50, remaining);
                    RecordSend(report, timer, ref contact, "stationary", Update | InRange | InContact, lastX, lastY);
                    Thread.Sleep(wait); remaining -= wait;
                    Sample(report, hwnd, timer, "stationary", lastX, lastY);
                }
                RecordSend(report, timer, ref contact, "up", Up, lastX, lastY);
                report.contactReleased = true;
                Sample(report, hwnd, timer, "up", lastX, lastY);
                report.success = true;
            }
            catch (Exception error) {
                report.error = error.GetType().Name + ": " + error.Message;
                report.hResult = error.HResult;
                Win32Exception nativeError = error as Win32Exception;
                if (nativeError != null) report.nativeErrorCode = nativeError.NativeErrorCode;
            }
            finally {
                if (!report.contactReleased) {
                    try { RecordSend(report, timer, ref contact, "cleanup-up", Up, lastX, lastY); report.contactReleased = true; }
                    catch (Exception error) {
                        report.releaseError = error.GetType().Name + ": " + error.Message;
                        report.releaseHResult = error.HResult;
                        Win32Exception nativeError = error as Win32Exception;
                        if (nativeError != null) report.releaseNativeErrorCode = nativeError.NativeErrorCode;
                    }
                }
                if (previousDpi != IntPtr.Zero) SetThreadDpiAwarenessContext(previousDpi);
            }
            return report;
        }
    }
}
'@
}

$reportPath = [System.IO.Path]::GetFullPath($OutputPath)
try {
    $handleValue = [Convert]::ToInt64($WindowHandle.Replace('0x', ''), 16)
    $report = [SlateRandom.Diagnostics.NativeTouch]::Run([uint32]$TargetProcessId, $handleValue, $MoveX, $MoveY, $Steps, $StepMilliseconds, $StationaryMilliseconds)
} catch {
    $report = @{ success = $false; contactReleased = $true; processId = $TargetProcessId; hwnd = $WindowHandle; error = $_.Exception.Message; samples = @() }
}
[System.IO.File]::WriteAllText($reportPath, (ConvertTo-Json -InputObject $report -Depth 7), (New-Object System.Text.UTF8Encoding($false)))
ConvertTo-Json -InputObject @{ success = $report.success; contactReleased = $report.contactReleased; processId = $TargetProcessId; hwnd = $WindowHandle; samples = @($report.samples).Count; outputPath = $reportPath; error = $report.error; nativeErrorCode = $report.nativeErrorCode; hResult = $report.hResult; releaseError = $report.releaseError; releaseNativeErrorCode = $report.releaseNativeErrorCode } -Compress
if (!$report.success -or !$report.contactReleased) { exit 1 }
