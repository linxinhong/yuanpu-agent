@echo off
setlocal
rem No execution-policy override; PowerShell uses the machine's normal policy.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -File "%~dp0task-008-installed-windows-probe.ps1" %*
exit /b %errorlevel%
