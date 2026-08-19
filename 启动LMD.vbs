Option Explicit

Dim fileSystem, shell, projectDirectory, trayScript, command
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

projectDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
trayScript = fileSystem.BuildPath(projectDirectory, "tray.ps1")
command = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -STA -File """ & trayScript & """"
If WScript.Arguments.Named.Exists("autostart") Then command = command & " -Autostart"

shell.Run command, 0, False

Set shell = Nothing
Set fileSystem = Nothing
