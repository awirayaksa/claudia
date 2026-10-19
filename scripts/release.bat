@echo off
REM Releases Claudia Desktop and Claudia Web; see scripts\release.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0release.ps1" %*
set RESULT=%ERRORLEVEL%
pause
exit /b %RESULT%
