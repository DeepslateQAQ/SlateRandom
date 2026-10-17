// SPDX-License-Identifier: GPL-3.0-or-later
// Independent Win32 implementation. See NOTICE.md and docs/PRIVILEGES.md.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Xml;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

internal static class Program
{
    private const int ConsentTimeoutMs = 120000;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    [STAThread]
    private static int Main(string[] args)
    {
        string responsePath = null;
        try
        {
            if (args.Length == 2 && args[0] == "status")
            {
                int pid;
                if (!Int32.TryParse(args[1], out pid) || pid < 1) throw new ArgumentException("Invalid process ID.");
                WriteJson(ReadStatus(pid));
                return 0;
            }
            if (args.Length == 2 && args[0] == "task-status")
            {
                LaunchRequest taskRequest = DecodeRequest(args[1]);
                ValidateTaskRequest(taskRequest, false);
                WriteJson(ReadTaskStatus(taskRequest));
                return 0;
            }
            if (args.Length == 3 && (args[0] == "task-install" || args[0] == "task-remove" || args[0] == "perform-task-install" || args[0] == "perform-task-remove"))
            {
                LaunchRequest taskRequest = DecodeRequest(args[1]);
                string operation = args[0].StartsWith("perform-", StringComparison.Ordinal) ? args[0].Substring(8) : args[0];
                ValidateTaskRequest(taskRequest, operation == "task-install");
                responsePath = ValidateResponsePath(args[2]);
                bool performing = args[0].StartsWith("perform-", StringComparison.Ordinal);
                Dictionary<string, object> taskResult = performing ? PerformTask(taskRequest, operation) : RequestElevation(args[1], responsePath, taskRequest, operation);
                if (performing) WriteResponse(responsePath, taskResult);
                else WriteJson(taskResult);
                return taskResult.ContainsKey("error") ? 2 : 0;
            }
            if (args.Length == 3 && (args[0] == "elevate-launch" || args[0] == "perform-launch"))
            {
                LaunchRequest request = DecodeRequest(args[1]);
                responsePath = ValidateResponsePath(args[2]);
                Dictionary<string, object> result;
                if (args[0] == "elevate-launch") result = RequestElevation(args[1], responsePath, request);
                else result = PerformLaunch(request);
                if (args[0] == "perform-launch") WriteResponse(responsePath, result);
                else WriteJson(result);
                return result.ContainsKey("error") ? 2 : 0;
            }
            throw new ArgumentException("Usage: SlateRandom.Privileges status PID | elevate-launch REQUEST_BASE64 RESPONSE_PATH");
        }
        catch (Exception exception)
        {
            Dictionary<string, object> failure = Failure(exception);
            if (args.Length > 0 && args[0].StartsWith("perform-", StringComparison.Ordinal) && responsePath != null)
            {
                try { WriteResponse(responsePath, failure); }
                catch { /* The parent reports a nonzero exit if the response cannot be written. */ }
            }
            else WriteJson(failure);
            return 2;
        }
    }

    private static void WriteJson(object value)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.WriteLine(Json.Serialize(value));
    }

    private static void WriteResponse(string responsePath, object value)
    {
        // The parent never observes a partially written JSON result.
        string pendingPath = responsePath + ".pending";
        File.WriteAllText(pendingPath, Json.Serialize(value), new UTF8Encoding(false));
        File.Move(pendingPath, responsePath);
    }

    private static LaunchRequest DecodeRequest(string encoded)
    {
        if (encoded.Length > 88000) throw new ArgumentException("Launch request is too long.");
        LaunchRequest request = Json.Deserialize<LaunchRequest>(Encoding.UTF8.GetString(Convert.FromBase64String(encoded)));
        if (request == null || String.IsNullOrWhiteSpace(request.executable) || !Path.IsPathRooted(request.executable))
            throw new ArgumentException("An absolute executable path is required.");
        request.executable = Path.GetFullPath(request.executable);
        if (!String.Equals(Path.GetExtension(request.executable), ".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(request.executable))
            throw new ArgumentException("The executable does not exist.");
        if (request.arguments == null) request.arguments = new string[0];
        if (request.arguments.Length > 64) throw new ArgumentException("Too many launch arguments.");
        foreach (string argument in request.arguments)
            if (argument == null || argument.IndexOf('\0') >= 0) throw new ArgumentException("Invalid launch argument.");
        request.workingDirectory = String.IsNullOrEmpty(request.workingDirectory) ? Path.GetDirectoryName(request.executable) : Path.GetFullPath(request.workingDirectory);
        if (!Directory.Exists(request.workingDirectory)) throw new ArgumentException("The working directory does not exist.");
        if (BuildCommandLine(request).Length > 30000) throw new ArgumentException("The command line is too long.");
        return request;
    }

    private static string ValidateResponsePath(string value)
    {
        string full = Path.GetFullPath(value);
        string directory = Path.GetDirectoryName(full);
        if (Path.GetFileName(full) != "result.json" || !Directory.Exists(directory) ||
            !Path.GetFileName(directory).StartsWith("SlateRandom-privileges-", StringComparison.Ordinal) ||
            !String.Equals(Path.GetDirectoryName(directory).TrimEnd(Path.DirectorySeparatorChar), Path.GetTempPath().TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("The response must use SlateRandom's temporary result directory.");
        return full;
    }

    private static Dictionary<string, object> RequestElevation(string encoded, string responsePath, LaunchRequest request, string operation = "launch")
    {
        Dictionary<string, object> current = ReadStatus(Process.GetCurrentProcess().Id);
        if ((bool)current["elevated"]) return operation == "launch" ? PerformLaunch(request) : PerformTask(request, operation);
        Native.ShellExecuteInfo shell = new Native.ShellExecuteInfo();
        shell.cbSize = Marshal.SizeOf(typeof(Native.ShellExecuteInfo));
        shell.fMask = 0x00000040; // SEE_MASK_NOCLOSEPROCESS
        shell.lpVerb = "runas";
        shell.lpFile = Assembly.GetExecutingAssembly().Location;
        shell.lpParameters = Quote("perform-" + operation) + " " + Quote(encoded) + " " + Quote(responsePath);
        shell.lpDirectory = Path.GetDirectoryName(shell.lpFile);
        shell.nShow = 0; // SW_HIDE; the standard Windows consent dialog remains visible.
        if (!Native.ShellExecuteEx(ref shell)) throw Error("Windows UAC request");
        using (SafeNativeHandle elevatedHelper = new SafeNativeHandle(shell.hProcess, true))
        {
            Stopwatch wait = Stopwatch.StartNew();
            while (wait.ElapsedMilliseconds < ConsentTimeoutMs)
            {
                if (File.Exists(responsePath)) return Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(responsePath, Encoding.UTF8));
                uint exitCode;
                if (Native.GetExitCodeProcess(elevatedHelper, out exitCode) && exitCode != 259)
                {
                    // The child can finish immediately after its last write; check once more.
                    if (File.Exists(responsePath)) return Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(responsePath, Encoding.UTF8));
                    throw new InvalidOperationException("The elevated helper stopped without a result (exit " + exitCode + ").");
                }
                Thread.Sleep(80);
            }
            throw new TimeoutException("The elevation request did not complete within two minutes.");
        }
    }

    private static void ValidateTaskRequest(LaunchRequest request, bool requireXml)
    {
        if (String.IsNullOrEmpty(request.taskName) || !Regex.IsMatch(request.taskName, "^SlateRandom-[a-f0-9]{12}$"))
            throw new ArgumentException("Invalid SlateRandom task name.");
        SecurityIdentifier userSid;
        try { userSid = new SecurityIdentifier(request.userSid); }
        catch (ArgumentException) { throw new ArgumentException("An interactive Windows user SID is required."); }
        if (!String.Equals(request.userSid, userSid.Value, StringComparison.Ordinal) ||
            !Regex.IsMatch(request.userSid, @"^S-1-(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*)){1,15}\z") ||
            userSid.IsWellKnown(WellKnownSidType.LocalSystemSid) ||
            userSid.IsWellKnown(WellKnownSidType.LocalServiceSid) ||
            userSid.IsWellKnown(WellKnownSidType.NetworkServiceSid))
            throw new ArgumentException("An interactive Windows user SID is required.");
        if (requireXml) ValidateTaskXml(request.taskXml, request);
    }

    private static XmlDocument ParseTaskXml(string xml)
    {
        if (String.IsNullOrWhiteSpace(xml) || xml.Length > 44000) throw new ArgumentException("Invalid scheduled-task XML.");
        XmlReaderSettings settings = new XmlReaderSettings();
        settings.DtdProcessing = DtdProcessing.Prohibit;
        settings.XmlResolver = null;
        XmlDocument document = new XmlDocument();
        document.XmlResolver = null;
        using (XmlReader reader = XmlReader.Create(new StringReader(xml), settings)) document.Load(reader);
        return document;
    }

    private static void ValidateTaskXml(string xml, LaunchRequest request)
    {
        XmlDocument document = ParseTaskXml(xml);
        XmlNamespaceManager names = new XmlNamespaceManager(document.NameTable);
        names.AddNamespace("t", "http://schemas.microsoft.com/windows/2004/02/mit/task");
        if (document.SelectNodes("/t:Task/t:Principals/t:Principal", names).Count != 1 ||
            document.SelectNodes("/t:Task/t:Triggers/*", names).Count != 1 ||
            document.SelectNodes("/t:Task/t:Actions/*", names).Count != 1)
            throw new ArgumentException("The startup task must contain one current-user principal, logon trigger and executable action.");
        RequireTaskValue(document, names, "/t:Task/t:RegistrationInfo/t:URI", TaskMarker(request.taskName));
        RequireTaskValue(document, names, "/t:Task/t:Principals/t:Principal/t:UserId", request.userSid);
        RequireTaskValue(document, names, "/t:Task/t:Principals/t:Principal/t:LogonType", "InteractiveToken");
        RequireTaskValue(document, names, "/t:Task/t:Principals/t:Principal/t:RunLevel", "HighestAvailable");
        RequireTaskValue(document, names, "/t:Task/t:Triggers/t:LogonTrigger/t:UserId", request.userSid);
        RequireTaskValue(document, names, "/t:Task/t:Triggers/t:LogonTrigger/t:Enabled", "true");
        RequireTaskValue(document, names, "/t:Task/t:Actions/t:Exec/t:Command", request.executable);
        List<string> arguments = new List<string>();
        foreach (string argument in request.arguments) arguments.Add(Quote(argument));
        RequireTaskValue(document, names, "/t:Task/t:Actions/t:Exec/t:Arguments", String.Join(" ", arguments.ToArray()));
        RequireTaskValue(document, names, "/t:Task/t:Actions/t:Exec/t:WorkingDirectory", request.workingDirectory);
        RequireTaskValue(document, names, "/t:Task/t:Settings/t:Hidden", "false");
        RequireTaskValue(document, names, "/t:Task/t:Settings/t:MultipleInstancesPolicy", "IgnoreNew");
    }

    private static void RequireTaskValue(XmlDocument document, XmlNamespaceManager names, string selector, string expected)
    {
        XmlNode node = document.SelectSingleNode(selector, names);
        if (node == null || node.InnerText != expected) throw new ArgumentException("Invalid scheduled-task setting: " + selector);
    }

    private static string TaskMarker(string taskName) { return "urn:slaterandom:autostart:" + taskName; }

    private static object ComCall(object target, string member, params object[] args)
    { return target.GetType().InvokeMember(member, BindingFlags.InvokeMethod, null, target, args); }
    private static object ComGet(object target, string member)
    { return target.GetType().InvokeMember(member, BindingFlags.GetProperty, null, target, null); }
    private static void ReleaseCom(object value)
    { if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value); }

    private static Exception Unwrap(Exception exception)
    {
        while (exception is TargetInvocationException && exception.InnerException != null) exception = exception.InnerException;
        return exception;
    }

    private static object FindTask(object folder, string taskName)
    {
        try { return ComCall(folder, "GetTask", taskName); }
        catch (Exception exception)
        {
            Exception cause = Unwrap(exception);
            if (cause.HResult == unchecked((int)0x80070002)) return null;
            throw cause;
        }
    }

    private static bool IsOwnedTask(object task, LaunchRequest request)
    {
        XmlDocument xml = ParseTaskXml((string)ComGet(task, "Xml"));
        XmlNamespaceManager names = new XmlNamespaceManager(xml.NameTable);
        names.AddNamespace("t", "http://schemas.microsoft.com/windows/2004/02/mit/task");
        XmlNode marker = xml.SelectSingleNode("/t:Task/t:RegistrationInfo/t:URI", names);
        XmlNode user = xml.SelectSingleNode("/t:Task/t:Principals/t:Principal/t:UserId", names);
        return marker != null && marker.InnerText == TaskMarker(request.taskName) && user != null && user.InnerText == request.userSid;
    }

    private static Dictionary<string, object> ReadTaskStatus(LaunchRequest request)
    {
        object service = null, folder = null, task = null;
        try
        {
            service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service", true));
            ComCall(service, "Connect");
            folder = ComCall(service, "GetFolder", "\\");
            task = FindTask(folder, request.taskName);
            return new Dictionary<string, object> { { "ok", true }, { "exists", task != null }, { "owned", task != null && IsOwnedTask(task, request) }, { "taskName", request.taskName } };
        }
        finally { ReleaseCom(task); ReleaseCom(folder); ReleaseCom(service); }
    }

    private static Dictionary<string, object> PerformTask(LaunchRequest request, string operation)
    {
        Dictionary<string, object> current = ReadStatus(Process.GetCurrentProcess().Id);
        if (!(bool)current["elevated"]) throw new InvalidOperationException("Administrator approval is required to change a highest-available startup task.");
        if ((string)current["userSid"] != request.userSid) throw new InvalidOperationException("The startup task must belong to the original signed-in Windows user, not another administrator account.");
        object service = null, folder = null, existing = null, registered = null;
        try
        {
            service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service", true));
            ComCall(service, "Connect");
            folder = ComCall(service, "GetFolder", "\\");
            existing = FindTask(folder, request.taskName);
            if (existing != null && !IsOwnedTask(existing, request)) throw new InvalidOperationException("The existing task belongs to another application or Windows user.");
            if (operation == "task-install")
            {
                ValidateTaskXml(request.taskXml, request);
                string permissions = "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;" + request.userSid + ")";
                // TASK_CREATE_OR_UPDATE = 6; TASK_LOGON_INTERACTIVE_TOKEN = 3.
                registered = ComCall(folder, "RegisterTask", request.taskName, request.taskXml, 6, request.userSid, null, 3, permissions);
                ValidateTaskXml((string)ComGet(registered, "Xml"), request);
                return new Dictionary<string, object> { { "ok", true }, { "installed", true }, { "taskName", request.taskName } };
            }
            if (existing != null) ComCall(folder, "DeleteTask", request.taskName, 0);
            registered = FindTask(folder, request.taskName);
            if (registered != null) throw new InvalidOperationException("Windows did not remove the SlateRandom startup task.");
            return new Dictionary<string, object> { { "ok", true }, { "installed", false }, { "taskName", request.taskName } };
        }
        finally { ReleaseCom(registered); ReleaseCom(existing); ReleaseCom(folder); ReleaseCom(service); }
    }

    private static Dictionary<string, object> PerformLaunch(LaunchRequest request)
    {
        Dictionary<string, object> current = ReadStatus(Process.GetCurrentProcess().Id);
        if (!(bool)current["elevated"]) throw new InvalidOperationException("UAC administrator elevation is required before UIAccess.");
        int pid;
        if (request.uiAccess)
        {
            using (SafeNativeHandle token = CreateUiAccessToken())
            {
                Native.StartupInfo startup = new Native.StartupInfo();
                startup.cb = Marshal.SizeOf(typeof(Native.StartupInfo));
                startup.lpDesktop = "winsta0\\default";
                // The elevated helper itself is hidden. Its launch preference
                // must not become the GUI child's first ShowWindow state.
                startup.dwFlags = 0x00000001; // STARTF_USESHOWWINDOW
                startup.wShowWindow = 1; // SW_SHOWNORMAL
                Native.ProcessInformation process;
                StringBuilder commandLine = new StringBuilder(BuildCommandLine(request));
                if (!Native.CreateProcessAsUser(token, request.executable, commandLine, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, request.workingDirectory, ref startup, out process))
                    throw Error("Creating the UIAccess process");
                using (SafeNativeHandle processHandle = new SafeNativeHandle(process.hProcess, true))
                using (SafeNativeHandle threadHandle = new SafeNativeHandle(process.hThread, true)) pid = process.dwProcessId;
            }
        }
        else
        {
            ProcessStartInfo start = new ProcessStartInfo(request.executable);
            List<string> arguments = new List<string>();
            foreach (string argument in request.arguments) arguments.Add(Quote(argument));
            start.Arguments = String.Join(" ", arguments.ToArray());
            start.WorkingDirectory = request.workingDirectory;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            using (Process process = Process.Start(start)) pid = process.Id;
        }
        Dictionary<string, object> status = ReadStatus(pid);
        if (!(bool)status["elevated"] || (request.uiAccess && !(bool)status["uiAccess"]))
            throw new InvalidOperationException("The new process token did not receive the requested permissions.");
        status["started"] = true;
        status["cancelled"] = false;
        return status;
    }

    private static SafeNativeHandle CreateUiAccessToken()
    {
        SafeNativeHandle self;
        if (!Native.OpenProcessToken(Native.GetCurrentProcess(), Native.TokenQuery | Native.TokenDuplicate | Native.TokenAdjustPrivileges, out self))
            throw Error("Reading the administrator token");
        using (self)
        using (PrivilegeScope debug = new PrivilegeScope(self, "SeDebugPrivilege"))
        {
            uint session = ReadTokenNumber(self, 12);
            using (SafeNativeHandle trusted = FindTrustedSessionToken(session))
            {
                if (!Native.SetThreadToken(IntPtr.Zero, trusted)) throw Error("Entering the trusted UIAccess operation");
                SafeNativeHandle uiToken = null;
                try
                {
                    uint access = Native.TokenQuery | Native.TokenDuplicate | Native.TokenAssignPrimary | Native.TokenAdjustDefault;
                    if (!Native.DuplicateTokenEx(self, access, IntPtr.Zero, 0, 1, out uiToken)) throw Error("Duplicating the application token");
                    uint enabled = 1;
                    if (!Native.SetTokenInformation(uiToken, 26, ref enabled, sizeof(uint))) throw Error("Setting TokenUIAccess");
                    if (ReadTokenNumber(uiToken, 26) != 1) throw new InvalidOperationException("Windows did not set TokenUIAccess.");
                    return uiToken;
                }
                catch
                {
                    if (uiToken != null) uiToken.Dispose();
                    throw;
                }
                finally
                {
                    // Never continue execution with a SYSTEM impersonation token.
                    if (!Native.RevertToSelf()) Environment.FailFast("Unable to release the temporary UIAccess impersonation token.");
                }
            }
        }
    }

    private static SafeNativeHandle FindTrustedSessionToken(uint session)
    {
        Native.Luid tcb;
        if (!Native.LookupPrivilegeValue(null, "SeTcbPrivilege", out tcb)) throw Error("Resolving the UIAccess privilege");
        foreach (Process candidate in Process.GetProcessesByName("winlogon"))
        using (candidate)
        {
            using (SafeNativeHandle process = Native.OpenProcess(0x1000, false, candidate.Id))
            {
                if (process.IsInvalid) continue;
                SafeNativeHandle token;
                if (!Native.OpenProcessToken(process.DangerousGetHandle(), Native.TokenQuery | Native.TokenDuplicate, out token)) continue;
                using (token)
                {
                    if (ReadTokenNumber(token, 12) != session) continue;
                    using (WindowsIdentity identity = new WindowsIdentity(token.DangerousGetHandle()))
                        if (identity.User == null || identity.User.Value != "S-1-5-18") continue;
                    Native.PrivilegeSet required = new Native.PrivilegeSet();
                    required.PrivilegeCount = 1;
                    required.Control = 1;
                    required.Privilege.Luid = tcb;
                    bool enabled;
                    if (!Native.PrivilegeCheck(token, ref required, out enabled) || !enabled) continue;
                    SafeNativeHandle impersonation;
                    if (!Native.DuplicateTokenEx(token, Native.TokenImpersonate, IntPtr.Zero, 2, 2, out impersonation)) throw Error("Preparing the same-session UIAccess privilege");
                    return impersonation;
                }
            }
        }
        throw new Win32Exception(1314, "The same-session trusted token is unavailable. Windows policy or security software may have blocked UIAccess.");
    }

    private static Dictionary<string, object> ReadStatus(int pid)
    {
        using (SafeNativeHandle process = Native.OpenProcess(0x1000, false, pid))
        {
            if (process.IsInvalid) throw Error("Opening the application process");
            SafeNativeHandle token;
            if (!Native.OpenProcessToken(process.DangerousGetHandle(), Native.TokenQuery, out token)) throw Error("Reading the application permissions");
            using (token)
            {
                Dictionary<string, object> result = new Dictionary<string, object> {
                    { "available", true }, { "elevated", ReadTokenNumber(token, 20) != 0 },
                    { "uiAccess", ReadTokenNumber(token, 26) != 0 }, { "processId", pid },
                    { "sessionId", ReadTokenNumber(token, 12) }
                };
                using (WindowsIdentity identity = new WindowsIdentity(token.DangerousGetHandle()))
                {
                    result["userSid"] = identity.User == null ? "" : identity.User.Value;
                    result["userName"] = identity.Name;
                }
                return result;
            }
        }
    }

    private static uint ReadTokenNumber(SafeNativeHandle token, int informationClass)
    {
        uint result, length;
        if (!Native.GetTokenInformation(token, informationClass, out result, sizeof(uint), out length)) throw Error("Reading the Windows token (class " + informationClass + ")");
        return result;
    }

    private static string BuildCommandLine(LaunchRequest request)
    {
        List<string> parts = new List<string>();
        parts.Add(Quote(request.executable));
        foreach (string argument in request.arguments) parts.Add(Quote(argument));
        return String.Join(" ", parts.ToArray());
    }

    // Microsoft C-runtime argv quoting, including quotes and trailing backslashes.
    private static string Quote(string value)
    {
        StringBuilder result = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { backslashes++; continue; }
            if (character == '"') result.Append('\\', backslashes * 2 + 1).Append('"');
            else result.Append('\\', backslashes).Append(character);
            backslashes = 0;
        }
        result.Append('\\', backslashes * 2).Append('"');
        return result.ToString();
    }

    private static Win32Exception Error(string stage)
    {
        int code = Marshal.GetLastWin32Error();
        return new Win32Exception(code, stage + ": " + new Win32Exception(code).Message);
    }

    private static Dictionary<string, object> Failure(Exception exception)
    {
        exception = Unwrap(exception);
        Win32Exception windows = exception as Win32Exception;
        int code = windows == null ? 0 : windows.NativeErrorCode;
        return new Dictionary<string, object> {
            { "available", true }, { "started", false }, { "ok", false }, { "cancelled", code == 1223 },
            { "elevated", false }, { "uiAccess", false }, { "error", exception.Message }, { "errorCode", code }
        };
    }

    private sealed class LaunchRequest
    {
        public string executable { get; set; }
        public string[] arguments { get; set; }
        public string workingDirectory { get; set; }
        public bool uiAccess { get; set; }
        public string taskName { get; set; }
        public string userSid { get; set; }
        public string taskXml { get; set; }
    }

    private sealed class PrivilegeScope : IDisposable
    {
        private readonly SafeNativeHandle token;
        private Native.TokenPrivileges previous;
        private bool restore;
        public PrivilegeScope(SafeNativeHandle handle, string name)
        {
            token = handle;
            Native.Luid luid;
            if (!Native.LookupPrivilegeValue(null, name, out luid)) throw Error("Resolving the administrator privilege");
            Native.TokenPrivileges desired = new Native.TokenPrivileges();
            desired.PrivilegeCount = 1;
            desired.Privilege.Luid = luid;
            desired.Privilege.Attributes = 2;
            uint returned;
            if (!Native.AdjustTokenPrivileges(token, false, ref desired, (uint)Marshal.SizeOf(typeof(Native.TokenPrivileges)), out previous, out returned))
                throw Error("Enabling the administrator privilege");
            int code = Marshal.GetLastWin32Error();
            if (code == 1300) throw new Win32Exception(code, "The administrator account lacks the required privilege.");
            restore = true;
        }
        public void Dispose()
        {
            if (!restore) return;
            Native.TokenPrivileges ignored;
            uint returned;
            Native.AdjustTokenPrivileges(token, false, ref previous, (uint)Marshal.SizeOf(typeof(Native.TokenPrivileges)), out ignored, out returned);
            restore = false;
        }
    }
}

internal sealed class SafeNativeHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    public SafeNativeHandle() : base(true) { }
    public SafeNativeHandle(IntPtr handle, bool ownsHandle) : base(ownsHandle) { SetHandle(handle); }
    protected override bool ReleaseHandle() { return Native.CloseHandle(handle); }
}

internal static class Native
{
    internal const uint TokenAssignPrimary = 0x0001, TokenDuplicate = 0x0002, TokenImpersonate = 0x0004,
        TokenQuery = 0x0008, TokenAdjustPrivileges = 0x0020, TokenAdjustDefault = 0x0080;
    [StructLayout(LayoutKind.Sequential)] internal struct Luid { public uint LowPart; public int HighPart; }
    [StructLayout(LayoutKind.Sequential)] internal struct LuidAttributes { public Luid Luid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] internal struct TokenPrivileges { public uint PrivilegeCount; public LuidAttributes Privilege; }
    [StructLayout(LayoutKind.Sequential)] internal struct PrivilegeSet { public uint PrivilegeCount; public uint Control; public LuidAttributes Privilege; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct StartupInfo
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct ProcessInformation
    { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct ShellExecuteInfo
    {
        public int cbSize; public uint fMask; public IntPtr hwnd; public string lpVerb, lpFile, lpParameters, lpDirectory;
        public int nShow; public IntPtr hInstApp, lpIDList; public string lpClass; public IntPtr hkeyClass;
        public uint dwHotKey; public IntPtr hIcon, hProcess;
    }
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] internal static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern SafeNativeHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetExitCodeProcess(SafeNativeHandle process, out uint code);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool OpenProcessToken(IntPtr process, uint access, out SafeNativeHandle token);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetTokenInformation(SafeNativeHandle token, int type, out uint information, uint length, out uint returned);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetTokenInformation(SafeNativeHandle token, int type, ref uint information, uint length);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool DuplicateTokenEx(SafeNativeHandle source, uint access, IntPtr attributes, int impersonation, int type, out SafeNativeHandle duplicate);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetThreadToken(IntPtr thread, SafeNativeHandle token);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool RevertToSelf();
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool PrivilegeCheck(SafeNativeHandle token, ref PrivilegeSet required, [MarshalAs(UnmanagedType.Bool)] out bool enabled);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool AdjustTokenPrivileges(SafeNativeHandle token, [MarshalAs(UnmanagedType.Bool)] bool disable, ref TokenPrivileges requested, uint length, out TokenPrivileges previous, out uint returned);
    [DllImport("advapi32.dll", EntryPoint = "CreateProcessAsUserW", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CreateProcessAsUser(SafeNativeHandle token, string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation process);
    [DllImport("shell32.dll", EntryPoint = "ShellExecuteExW", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool ShellExecuteEx(ref ShellExecuteInfo information);
}
