param(
    [switch]$StopService,
    [switch]$CheckService,
    [Alias('AppRoot')][string]$TargetAppRoot = ''
)

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

function ConvertTo-HeadachePathKey {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/').ToLowerInvariant()
}

function Initialize-HeadacheInspectionModules {
    # A launcher started by PowerShell 7 can inherit its module path in Windows PowerShell 5.1.
    $windowsModules = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
    if (@($env:PSModulePath -split ';') -notcontains $windowsModules) {
        $env:PSModulePath = $env:PSModulePath + ';' + $windowsModules
    }
    if (-not (Get-Command Get-CimInstance -ErrorAction SilentlyContinue)) { Import-Module CimCmdlets -ErrorAction Stop }
    if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { Import-Module NetTCPIP -ErrorAction Stop }
}

function Get-HeadacheRuntimeContext {
    param([Parameter(Mandatory = $true)][string]$AppRoot)
    $root = [System.IO.Path]::GetFullPath($AppRoot).TrimEnd('\', '/')
    $markerPath = Join-Path $root 'installation.json'
    if (-not (Test-Path -LiteralPath $markerPath) -and
        ((Test-Path -LiteralPath (Join-Path $root 'build-meta.json')) -or (Test-Path -LiteralPath (Join-Path $root 'payload-manifest.json')))) {
        throw '安装标记缺失，但仍有安装文件。为保护原病历，未回退到开发数据目录；请联系维护人员修复安装标记。'
    }
    $mode = 'application-directory'
    $port = 17843
    $dataDirectory = Join-Path $root 'data'
    if (Test-Path -LiteralPath $markerPath) {
        try { $marker = [System.IO.File]::ReadAllText($markerPath) | ConvertFrom-Json }
        catch { throw '安装标记无法读取。请修复安装；为保护病历，没有回退到其他数据目录。' }
        if ($marker.schemaVersion -ne 1 -or $marker.app -ne 'headache-diary' -or $marker.installMode -ne 'per-user') {
            throw '安装标记无效。请修复安装；为保护病历，没有回退到其他数据目录。'
        }
        if (-not ($marker.port -is [int] -or $marker.port -is [long]) -or $marker.port -lt 1024 -or $marker.port -gt 65535) {
            throw '安装标记中的端口无效。'
        }
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw '无法定位本用户的数据目录。' }
        $mode = 'per-user'
        $port = [int]$marker.port
        $dataDirectory = Join-Path $env:LOCALAPPDATA 'HeadacheDiary\data'
    }
    return [PSCustomObject]@{
        AppRoot = $root
        DataDirectory = [System.IO.Path]::GetFullPath($dataDirectory)
        InstallMode = $mode
        Port = $port
        Url = 'http://127.0.0.1:' + $port + '/'
        MutexName = 'Local\HeadacheDiaryLaunch-' + $port
    }
}

function Invoke-HeadacheJson {
    param([Parameter(Mandatory = $true)][string]$Url, [string]$Method = 'GET', [string]$Origin = '', [int]$TimeoutMilliseconds = 500)
    $response = $null
    $reader = $null
    try {
        $request = [System.Net.HttpWebRequest]::Create($Url)
        $request.Timeout = $TimeoutMilliseconds
        $request.ReadWriteTimeout = $TimeoutMilliseconds
        $request.AllowAutoRedirect = $false
        $request.Method = $Method
        if ($Origin) { $request.Headers.Add('Origin', $Origin) }
        if ($Method -eq 'POST') {
            $request.ContentType = 'application/json'
            $request.ContentLength = 2
            $stream = $request.GetRequestStream()
            try { $stream.Write([Text.Encoding]::UTF8.GetBytes('{}'), 0, 2) }
            finally { $stream.Dispose() }
        }
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        return ($reader.ReadToEnd() | ConvertFrom-Json)
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

function Test-HeadacheIdentity {
    param($Context, $Identity)
    try {
        return (
            $Identity.app -eq 'headache-diary' -and $Identity.version -eq 1 -and
            $Identity.port -eq $Context.Port -and $Identity.installMode -eq $Context.InstallMode -and
            $Identity.pid -gt 0 -and
            (ConvertTo-HeadachePathKey $Identity.appRoot) -eq (ConvertTo-HeadachePathKey $Context.AppRoot) -and
            (ConvertTo-HeadachePathKey $Identity.dataDirectory) -eq (ConvertTo-HeadachePathKey $Context.DataDirectory)
        )
    } catch { return $false }
}

function Get-HeadacheServiceStatus {
    param($Context)
    try { $health = Invoke-HeadacheJson ($Context.Url + 'api/health') }
    catch { return [PSCustomObject]@{ Healthy = $false; Matched = $false; Legacy = $false; Identity = $null } }
    if ($health.app -ne 'headache-diary' -or $health.version -ne 1) {
        return [PSCustomObject]@{ Healthy = $false; Matched = $false; Legacy = $false; Identity = $null }
    }
    try {
        $identity = Invoke-HeadacheJson ($Context.Url + 'api/instance')
        return [PSCustomObject]@{ Healthy = $true; Matched = (Test-HeadacheIdentity $Context $identity); Legacy = $false; Identity = $identity }
    } catch {
        # Existing development sessions can run until their next normal restart.
        # Installed instances always require identity and never use this fallback.
        $allowLegacy = $false
        if ($Context.InstallMode -eq 'application-directory') {
            try {
                Initialize-HeadacheInspectionModules
                $legacyListeners = @(Get-NetTCPConnection -LocalPort $Context.Port -State Listen -ErrorAction Stop)
                if ($legacyListeners.Count -eq 1 -and $legacyListeners[0].LocalAddress -eq '127.0.0.1') {
                    $legacyProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $legacyListeners[0].OwningProcess)
                    $legacyServerPath = Join-Path $Context.AppRoot 'server.js'
                    $legacyPattern = '(?i)(?:^|\s)(?:"' + [regex]::Escape($legacyServerPath) + '"|' + [regex]::Escape($legacyServerPath) + ')(?=\s|$)'
                    $allowLegacy = $legacyProcess.Name -eq 'node.exe' -and $legacyProcess.CommandLine -match $legacyPattern
                }
            } catch { $allowLegacy = $false }
        }
        return [PSCustomObject]@{ Healthy = $true; Matched = $allowLegacy; Legacy = $allowLegacy; Identity = $null }
    }
}

function Test-HeadacheListeningPort {
    param([int]$Port)
    $probe = New-Object System.Net.Sockets.TcpClient
    try {
        $connecting = $probe.ConnectAsync('127.0.0.1', $Port)
        return ($connecting.Wait(400) -and $probe.Connected)
    } catch { return $false }
    finally { $probe.Dispose() }
}

function Stop-HeadacheInstalledService {
    param($Context)
    if ($Context.InstallMode -ne 'per-user') { throw '停止服务操作仅适用于带安装标记的安装版；开发实例未被停止。' }
    $status = Get-HeadacheServiceStatus $Context
    if (-not $status.Matched) {
        if (-not (Test-HeadacheListeningPort $Context.Port)) { return '本安装实例未运行。' }
        throw '该端口不是本安装实例，未停止任何进程。请先确认正在使用的安装位置。'
    }
    $ownedProcessId = [int]$status.Identity.pid
    Initialize-HeadacheInspectionModules
    $listeners = @(Get-NetTCPConnection -LocalPort $Context.Port -State Listen -ErrorAction Stop)
    if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1' -or $listeners[0].OwningProcess -ne $ownedProcessId) {
        throw '无法确认本安装服务的监听进程，未停止任何进程。'
    }
    $processInfo = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ownedProcessId)
    $serverPath = Join-Path $Context.AppRoot 'server.js'
    $argumentPattern = '(?i)(?:^|\s)(?:"' + [regex]::Escape($serverPath) + '"|' + [regex]::Escape($serverPath) + ')(?=\s|$)'
    if ($processInfo.Name -ne 'node.exe' -or $processInfo.CommandLine -notmatch $argumentPattern) {
        throw '监听进程不是本安装程序的 Node 服务，未停止任何进程。'
    }
    $confirmed = Invoke-HeadacheJson ($Context.Url + 'api/instance')
    if (-not (Test-HeadacheIdentity $Context $confirmed) -or $confirmed.pid -ne $ownedProcessId) {
        throw '服务身份已变化，未停止任何进程。请稍后重试。'
    }
    $ownedProcess = Get-Process -Id $ownedProcessId -ErrorAction Stop
    $stopping = Invoke-HeadacheJson -Url ($Context.Url + 'api/shutdown') -Method POST -Origin $Context.Url.TrimEnd('/') -TimeoutMilliseconds 5000
    if ($stopping.stopping -ne $true -or $stopping.pid -ne $ownedProcessId) { throw '服务未确认安全退出，请稍后重试。' }
    if (-not $ownedProcess.WaitForExit(8000)) { throw '服务仍在保存或退出中，未强行结束进程。请稍后重试安装或卸载。' }
    return ('已安全停止本安装实例，PID ' + $ownedProcessId + '；病历文件未被删除。')
}

if ($StopService -or $CheckService) {
    try {
        if (-not $TargetAppRoot) {
            if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'server.js')) { $TargetAppRoot = $PSScriptRoot }
            else { $TargetAppRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')) }
        }
        $context = Get-HeadacheRuntimeContext $TargetAppRoot
        if ($StopService) { Write-Output (Stop-HeadacheInstalledService $context) }
        else {
            $status = Get-HeadacheServiceStatus $context
            [PSCustomObject]@{ appRoot = $context.AppRoot; dataDirectory = $context.DataDirectory; port = $context.Port; installMode = $context.InstallMode; healthy = $status.Healthy; matched = $status.Matched; legacy = $status.Legacy } | ConvertTo-Json -Compress
        }
        exit 0
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 3
    }
}
