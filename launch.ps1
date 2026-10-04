param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$launchMutex = $null
$hasMutex = $false

try {
    $runtimeHelper = Join-Path $appRoot 'runtime-support.ps1'
    if (-not (Test-Path -LiteralPath $runtimeHelper -PathType Leaf)) { $runtimeHelper = Join-Path $appRoot 'installer\runtime-support.ps1' }
    if (-not (Test-Path -LiteralPath $runtimeHelper -PathType Leaf)) { throw '缺少本机启动支持文件，请修复安装。' }
    . $runtimeHelper
    $context = Get-HeadacheRuntimeContext $appRoot
    $appUrl = $context.Url
    $dataDirectory = $context.DataDirectory
    $launchMutex = New-Object System.Threading.Mutex($false, $context.MutexName)
    $hasMutex = $launchMutex.WaitOne(7000)
    if (-not $hasMutex) { throw '正在启动，请稍等几秒后再点击桌面图标。' }
    $serviceStatus = Get-HeadacheServiceStatus $context
    if (-not $serviceStatus.Matched) {
        if (Test-HeadacheListeningPort $context.Port) {
            throw ('本机端口 ' + $context.Port + ' 已被其他程序或另一份安装占用，未切换病历目录。请关闭对应程序后再打开。')
        }
        $bundledNode = Join-Path $appRoot 'runtime\node.exe'
        $nodePath = if (Test-Path -LiteralPath $bundledNode -PathType Leaf) { $bundledNode } else { $null }
        if (-not $nodePath -and $context.InstallMode -eq 'per-user') { throw '安装包中的 Node.js 运行环境缺失。请修复安装后再打开头痛记录。' }
        if (-not $nodePath) {
            $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
            if ($nodeCommand) { $nodePath = $nodeCommand.Source }
        }
        if (-not $nodePath) {
            $nodeCandidates = @(
                (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
                (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
            )
            $nodePath = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
        }
        if (-not $nodePath) { throw '找不到 Node.js 本机运行环境。请修复安装，或把 node.exe 放在程序的 runtime 文件夹中。' }
        New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
        $env:HEADACHE_PORT = [string]$context.Port
        $env:HEADACHE_DATA_DIR = $dataDirectory
        $env:HEADACHE_INSTALL_MODE = $context.InstallMode
        $serverPath = Join-Path $appRoot 'server.js'
        Start-Process -FilePath $nodePath -ArgumentList @('"' + $serverPath + '"') -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDirectory 'server.log') -RedirectStandardError (Join-Path $dataDirectory 'server.error.log') | Out-Null
        $startWatch = [System.Diagnostics.Stopwatch]::StartNew()
        $serviceStatus = Get-HeadacheServiceStatus $context
        while (-not $serviceStatus.Matched -and $startWatch.Elapsed.TotalSeconds -lt 4) {
            Start-Sleep -Milliseconds 100
            $serviceStatus = Get-HeadacheServiceStatus $context
        }
        if (-not $serviceStatus.Matched) { throw '头痛记录服务启动失败或身份不符。请查看病历目录中的 server.error.log。' }
    }
    if ($NoBrowser) { Write-Output ('本机服务已就绪：' + $appUrl) }
    else {
        $browserCandidates = @(
            (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
            (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
            (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe'),
            (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
            (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
        )
        $browserPath = $browserCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
        if ($browserPath) { Start-Process -FilePath $browserPath -ArgumentList ('--app=' + $appUrl) }
        else { Start-Process $appUrl }
    }
} catch {
    if ($NoBrowser) { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '头痛记录', 'OK', 'Error') | Out-Null
    exit 1
} finally {
    if ($hasMutex) { $launchMutex.ReleaseMutex() }
    if ($launchMutex) { $launchMutex.Dispose() }
}
