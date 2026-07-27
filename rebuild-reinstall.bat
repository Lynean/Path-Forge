@echo off
rem ============================================================
rem  PathForge - rebuild and reinstall the desktop app
rem  Double-click this file. It will:
rem    1. close the running app
rem    2. rebuild the UI, the API server, and the installer
rem    3. launch the installer (follow the wizard)
rem  It stops if any build step fails (nothing gets installed).
rem ============================================================
setlocal
cd /d "%~dp0"
set VITE_LOCAL_MODE=1

echo(
echo ============================================================
echo   PathForge - rebuild and reinstall
echo ============================================================
echo(

echo [1/5] Closing PathForge if it is running...
taskkill /IM PathForge.exe /F >nul 2>&1

echo [2/5] Building the app UI (local mode)...
call pnpm --filter @workspace/app run build
if errorlevel 1 goto :fail

echo [3/5] Building the API server...
call pnpm --filter @workspace/api-server run build
if errorlevel 1 goto :fail

echo [4/5] Packaging the installer (this takes a couple of minutes)...
call pnpm --filter @workspace/agent-desktop run package
if errorlevel 1 goto :fail

set "INSTALLER=%~dp0artifacts\agent-desktop\release\PathForge Setup 0.0.0.exe"
if not exist "%INSTALLER%" (
  echo   ERROR: installer not found at "%INSTALLER%"
  goto :fail
)

echo [5/5] Launching the installer - follow the prompts...
rem  (For an unattended silent install instead, add /S:  start /wait "" "%INSTALLER%" /S)
start /wait "" "%INSTALLER%"

echo(
echo   Done. PathForge has been rebuilt and reinstalled.
echo   Launch it from the Start Menu or desktop shortcut, then
echo   add your OpenRouter key in Profile -^> Settings.
echo(
pause
endlocal
goto :eof

:fail
echo(
echo   BUILD FAILED - see the messages above. Nothing was installed.
echo(
pause
endlocal
exit /b 1
