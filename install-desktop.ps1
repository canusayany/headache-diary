$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$desktopPath = [Environment]::GetFolderPath('DesktopDirectory')
$shortcutPath = Join-Path $desktopPath '头痛记录.lnk'
$launcherPath = Join-Path $appRoot 'launch.vbs'
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) { throw '缺少 launch.vbs，无法创建桌面图标。' }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shortcut.Arguments = '"' + $launcherPath + '"'
$shortcut.WorkingDirectory = $appRoot
$shortcut.Description = '打开本机头痛记录；无需联网，自动保存到本机。'
$customIcon = Join-Path $appRoot 'icons\app.ico'
if (Test-Path -LiteralPath $customIcon -PathType Leaf) { $shortcut.IconLocation = $customIcon + ',0' }
else {
    $edgeIcon = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
    if (Test-Path -LiteralPath $edgeIcon -PathType Leaf) { $shortcut.IconLocation = $edgeIcon + ',0' }
}
$shortcut.Save()
Write-Output ('已创建桌面图标：' + $shortcutPath)
