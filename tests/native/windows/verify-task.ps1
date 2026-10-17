param([Parameter(Mandatory = $true)][string]$HelperPath, [Parameter(Mandatory = $true)][string]$EncodedRequest)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$assembly = [Reflection.Assembly]::LoadFile([IO.Path]::GetFullPath($HelperPath))
$program = $assembly.GetType('Program')
$decode = $program.GetMethod('DecodeRequest', [Reflection.BindingFlags]'NonPublic,Static')
$validate = $program.GetMethod('ValidateTaskRequest', [Reflection.BindingFlags]'NonPublic,Static')
$request = $decode.Invoke($null, @($EncodedRequest))
$validate.Invoke($null, @($request, $true))
$originalXml = $request.taskXml
$originalName = $request.taskName
$rejected = 0
foreach ($kind in @('system', 'password', 'hidden', 'name')) {
    $request.taskXml = $originalXml
    $request.taskName = $originalName
    switch ($kind) {
        'system' { $request.taskXml = $originalXml.Replace($request.userSid, 'S-1-5-18') }
        'password' { $request.taskXml = $originalXml.Replace('InteractiveToken', 'Password') }
        'hidden' { $request.taskXml = $originalXml.Replace('<Hidden>false</Hidden>', '<Hidden>true</Hidden>') }
        'name' { $request.taskName = 'AnotherApplication' }
    }
    $wasRejected = $false
    try { $validate.Invoke($null, @($request, $true)) }
    catch { $wasRejected = $true; $rejected++ }
    if (-not $wasRejected) { throw 'Unsafe task XML was unexpectedly accepted.' }
}
$request.taskName = $originalName
$originalSid = $request.userSid
$sidAccepted = 0
foreach ($sid in @($originalSid, 'S-1-12-1-111-222-333-444', 'S-1-0-0', ('S-1-5-' + ((1..15 | ForEach-Object { '4294967295' }) -join '-')))) {
    $request.userSid = $sid
    $request.taskXml = $originalXml.Replace($originalSid, $sid)
    $validate.Invoke($null, @($request, $true))
    $sidAccepted++
}
$sidRejected = 0
foreach ($sid in @('S-1-5-18', 'S-1-5-19', 'S-1-5-20', 'S-1-5', 'S-2-5-1', 'S-1-05-1', 'S-1-5-01', 'S-1-5--1', 'S-1-281474976710656-1', 'S-1-5-4294967296', ('S-1-5-' + ((1..16 | ForEach-Object { '1' }) -join '-')), 'S-1-5-1 ')) {
    $request.userSid = $sid
    $request.taskXml = $originalXml.Replace($originalSid, $sid)
    $wasRejected = $false
    try { $validate.Invoke($null, @($request, $true)) }
    catch { $wasRejected = $true; $sidRejected++ }
    if (-not $wasRejected) { throw "Unsafe SID was unexpectedly accepted: $sid" }
}
@{ validAccepted = $true; unsafeRejected = $rejected; sidAccepted = $sidAccepted; sidRejected = $sidRejected } | ConvertTo-Json -Compress
