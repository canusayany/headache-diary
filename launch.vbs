Option Explicit
Dim shell, fileSystem, appDirectory, powershellPath, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
appDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
powershellPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
command = """" & powershellPath & """ -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & appDirectory & "\launch.ps1"""
If WScript.Arguments.Named.Exists("NoBrowser") Then command = command & " -NoBrowser"
shell.Run command, 0, False
