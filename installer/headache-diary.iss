#ifndef AppVersion
  #define AppVersion "1.3.1"
#endif
#ifndef PayloadDir
  #define PayloadDir "..\dist\staging"
#endif
#ifndef InstallerOutputDir
  #define InstallerOutputDir "..\dist"
#endif

[Setup]
AppId={{C8AC86D2-70DB-4BE7-94AD-D23434F3A0D9}
AppName=头痛记录
AppVersion={#AppVersion}
AppVerName=头痛记录 {#AppVersion}
AppPublisher=头痛记录
VersionInfoDescription=头痛记录安装程序
VersionInfoProductName=头痛记录
VersionInfoVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\HeadacheDiary
DefaultGroupName=头痛记录
PrivilegesRequired=lowest
MinVersion=10.0
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern dark includetitlebar
DisableWelcomePage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
AllowNoIcons=yes
DisableReadyPage=no
DisableFinishedPage=no
UninstallDisplayName=头痛记录
UninstallDisplayIcon={app}\icons\app.ico
SetupIconFile={#PayloadDir}\icons\app.ico
OutputDir={#InstallerOutputDir}
OutputBaseFilename=HeadacheDiary-Setup-{#AppVersion}-x64
Compression=lzma2
SolidCompression=yes
CloseApplications=no
RestartApplications=no
SetupLogging=yes
UninstallLogging=yes

[Languages]
Name: "chinesesimp"; MessagesFile: "ChineseSimplified.isl"

[Messages]
ReadyLabel1=点击「安装」即可完成。以后从桌面的「头痛记录」图标打开。
FinishedLabel=头痛记录已经安装完成。%n%n点一次「记一次头痛」即可保存，不需要分别记开始和结束。界面默认采用暗色。
ConfirmUninstall=要卸载头痛记录吗？%n%n程序和快捷方式会删除，健康记录与自动备份会保留。
UninstalledAll=头痛记录已卸载。%n%n健康记录仍保存在当前用户的 HeadacheDiary\data 文件夹，重新安装后可继续使用。

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userdesktop}\头痛记录"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launch.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\icons\app.ico"; Check: not WizardNoIcons
Name: "{userprograms}\头痛记录\头痛记录"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launch.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\icons\app.ico"; Check: not WizardNoIcons
Name: "{userprograms}\头痛记录\使用说明"; Filename: "{sys}\notepad.exe"; Parameters: """{app}\使用说明.md"""; WorkingDir: "{app}"; Check: not WizardNoIcons

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\launch.vbs"""; Description: "打开头痛记录"; Flags: postinstall nowait skipifsilent

[Code]
function StopInstalledService(): Boolean;
var
  SupportPath: String;
  PowerShellPath: String;
  ResultCode: Integer;
begin
  Result := True;
  SupportPath := ExpandConstant('{app}\runtime-support.ps1');
  if not FileExists(ExpandConstant('{app}\installation.json')) then begin
    if FileExists(ExpandConstant('{app}\build-meta.json')) or FileExists(ExpandConstant('{app}\payload-manifest.json')) then
      Result := False;
    exit;
  end;
  if not FileExists(SupportPath) then begin
    Result := False;
    exit;
  end;
  PowerShellPath := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  Result := Exec(PowerShellPath,
    '-NoProfile -ExecutionPolicy Bypass -File "' + SupportPath + '" -StopService -AppRoot "' + ExpandConstant('{app}') + '"',
    ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if Result then Result := ResultCode = 0;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not StopInstalledService() then
    Result := '无法安全关闭此前的头痛记录服务。没有覆盖程序，也没有删除记录。请先关闭窗口，联系维护人员检查端口与数据目录，然后再试。';
end;

function InitializeUninstall(): Boolean;
begin
  Result := StopInstalledService();
  if not Result then
    MsgBox('无法安全关闭头痛记录服务，卸载已取消，记录仍然保留。请联系维护人员检查后再试。', mbError, MB_OK);
end;
