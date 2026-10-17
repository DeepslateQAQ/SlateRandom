param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$TargetProcessId
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

if (-not ('SlateRandom.Diagnostics.NativeWindows' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace SlateRandom.Diagnostics
{
    public sealed class WindowBounds
    {
        public int x;
        public int y;
        public int width;
        public int height;
    }

    public sealed class WindowRecord
    {
        public string hwnd;
        public string title;
        public string className;
        public bool isVisible;
        public bool layered;
        public bool hasNativeRegion;
        public WindowBounds bounds;
        public uint processId;
        public uint threadId;
        public uint sessionId;
        public string desktop;
    }

    public static class NativeWindows
    {
        private delegate bool EnumWindowsCallback(IntPtr handle, IntPtr parameter);

        [StructLayout(LayoutKind.Sequential)]
        private struct Rect { public int left, top, right, bottom; }

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsWindowVisible(IntPtr handle);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
        private static extern IntPtr GetWindowLongPtr(IntPtr handle, int index);
        [DllImport("user32.dll")]
        private static extern int GetWindowRgn(IntPtr handle, IntPtr region);
        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr value);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetWindowRect(IntPtr handle, out Rect bounds);

        [DllImport("user32.dll", EntryPoint = "GetWindowTextW", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr handle, StringBuilder value, int capacity);

        [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr handle, StringBuilder value, int capacity);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr GetThreadDesktop(uint threadId);

        [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint length, out uint required);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

        private static string DesktopName(uint threadId)
        {
            IntPtr desktop = GetThreadDesktop(threadId);
            if (desktop == IntPtr.Zero) return null;
            StringBuilder name = new StringBuilder(512);
            uint required;
            // GetThreadDesktop returns an existing handle; it must not be closed here.
            return GetUserObjectInformation(desktop, 2, name, (uint)(name.Capacity * 2), out required) ? name.ToString() : null;
        }

        public static WindowRecord[] Inspect(uint targetProcessId)
        {
            uint sessionId;
            if (!ProcessIdToSessionId(targetProcessId, out sessionId))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot read the target process session.");
            List<WindowRecord> records = new List<WindowRecord>();
            EnumWindowsCallback callback = delegate(IntPtr handle, IntPtr parameter)
            {
                uint owner;
                uint threadId = GetWindowThreadProcessId(handle, out owner);
                if (owner != targetProcessId) return true;
                Rect bounds;
                if (!GetWindowRect(handle, out bounds)) return true; // The window may close during enumeration.
                StringBuilder title = new StringBuilder(4096);
                StringBuilder className = new StringBuilder(512);
                GetWindowText(handle, title, title.Capacity);
                GetClassName(handle, className, className.Capacity);
                IntPtr region = CreateRectRgn(0, 0, 0, 0);
                bool shaped = false;
                try { shaped = region != IntPtr.Zero && GetWindowRgn(handle, region) > 0; }
                finally { if (region != IntPtr.Zero) DeleteObject(region); }
                records.Add(new WindowRecord {
                    hwnd = "0x" + handle.ToInt64().ToString("X"),
                    title = title.ToString(), className = className.ToString(),
                    isVisible = IsWindowVisible(handle), processId = owner, threadId = threadId,
                    layered = (GetWindowLongPtr(handle, -20).ToInt64() & 0x00080000L) != 0,
                    hasNativeRegion = shaped,
                    sessionId = sessionId, desktop = DesktopName(threadId),
                    bounds = new WindowBounds { x = bounds.left, y = bounds.top,
                        width = bounds.right - bounds.left, height = bounds.bottom - bounds.top }
                });
                return true;
            };
            if (!EnumWindows(callback, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot enumerate desktop windows.");
            GC.KeepAlive(callback);
            return records.ToArray();
        }
    }
}
'@
}

$records = [SlateRandom.Diagnostics.NativeWindows]::Inspect([uint32]$TargetProcessId)
ConvertTo-Json -InputObject @($records) -Depth 5 -Compress
