param([string]$CompilerPath, [string]$RuntimeDirectory)
$ErrorActionPreference = 'Stop'
$applicationRoot = Split-Path -Parent $PSScriptRoot
if (-not $CompilerPath) { $CompilerPath = Join-Path $applicationRoot 'build-tools\inno-setup\ISCC.exe' }
if (-not $RuntimeDirectory) { $RuntimeDirectory = Join-Path $applicationRoot 'build-tools\node-runtime' }
$compiler = Get-Item -LiteralPath $CompilerPath -ErrorAction Stop
$runtime = Get-Item -LiteralPath (Join-Path $RuntimeDirectory 'node.exe') -ErrorAction Stop
$version = (Get-Content -LiteralPath (Join-Path $applicationRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid application version' }
$outputDirectory = Join-Path $applicationRoot 'dist'
$payloadDirectory = Join-Path $outputDirectory 'staging'
& $runtime.FullName (Join-Path $applicationRoot 'scripts\stage-installer.mjs') --runtime-dir $runtime.DirectoryName --output $payloadDirectory
if ($LASTEXITCODE -ne 0) { throw 'Payload staging failed' }
& $compiler.FullName "/DAppVersion=$version" "/DPayloadDir=$payloadDirectory" "/DInstallerOutputDir=$outputDirectory" (Join-Path $applicationRoot 'installer\headache-diary.iss')
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed' }
$installer = Get-Item -LiteralPath (Join-Path $outputDirectory "HeadacheDiary-Setup-$version-x64.exe")
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
$installerStream = [IO.File]::OpenRead($installer.FullName)
try { $hash = [BitConverter]::ToString($hashAlgorithm.ComputeHash($installerStream)).Replace('-', '').ToLowerInvariant() }
finally { $installerStream.Dispose(); $hashAlgorithm.Dispose() }
[IO.File]::WriteAllText((Join-Path $outputDirectory 'SHA256SUMS.txt'), "$hash  $($installer.Name)`n", [Text.UTF8Encoding]::new($false))
Write-Output "Installer: $($installer.FullName)"
Write-Output "SHA256: $hash"
