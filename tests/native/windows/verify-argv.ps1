param([Parameter(Mandatory = $true)][string]$HelperPath)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$assembly = [Reflection.Assembly]::LoadFile([IO.Path]::GetFullPath($HelperPath))
$program = $assembly.GetType('Program')
$quote = $program.GetMethod('Quote', [Reflection.BindingFlags]'NonPublic,Static')

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SlateArgumentParser {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr memory);
}
'@

$fixtures = @('', 'a', 'a b', "a`tb", '中文 学生', 'a"b', '\', '\\', 'C:\目录\末尾\', 'a\"b', 'a\\"b', '"start', 'end"', 'two "quotes" here', '--flag=value')
$results = @()
foreach ($value in $fixtures) {
    $quoted = $quote.Invoke($null, @($value))
    $count = 0
    $pointer = [SlateArgumentParser]::CommandLineToArgvW('SlateRandom.exe ' + $quoted, [ref]$count)
    if ($pointer -eq [IntPtr]::Zero) { throw 'CommandLineToArgvW failed.' }
    try {
        if ($count -ne 2) { throw "Expected one argument; got $count total values." }
        $argumentPointer = [Runtime.InteropServices.Marshal]::ReadIntPtr($pointer, [IntPtr]::Size)
        $parsed = [Runtime.InteropServices.Marshal]::PtrToStringUni($argumentPointer)
        if ($parsed -cne $value) { throw 'A quoted argument did not round trip through the Windows parser.' }
        $results += @{ value = $value; quoted = $quoted; parsed = $parsed }
    }
    finally { [void][SlateArgumentParser]::LocalFree($pointer) }
}
$results | ConvertTo-Json -Depth 4 -Compress
