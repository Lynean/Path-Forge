@echo off
rem ============================================================
rem  PathForge - local LLM proxy + installed desktop app
rem
rem  The desktop app starts its own embedded API server. This file
rem  starts only the separate LLM proxy, then launches PathForge
rem  with the proxy URL in its environment.
rem ============================================================

setlocal
cd /d "%~dp0"
set "FAIL_REASON=Unknown startup failure."
set "DESKTOP_EXE=%LOCALAPPDATA%\Programs\PathForge\PathForge.exe"
set "DESKTOP_DIR=%LOCALAPPDATA%\Programs\PathForge"
set "PATHFORGE_PROXY_URL=http://127.0.0.1:8080"

echo(
echo ============================================================
echo   PathForge - proxy + desktop app
echo ============================================================
echo(

where pnpm >nul 2>&1
if errorlevel 1 (
  set "FAIL_REASON=pnpm was not found in PATH."
  goto :fail
)

if not exist ".env" (
  set "FAIL_REASON=.env was not found in %CD%."
  goto :fail
)

findstr /R /B /C:"OPENROUTER_API_KEY=." ".env" >nul
if errorlevel 1 (
  set "FAIL_REASON=.env does not contain a non-empty OPENROUTER_API_KEY."
  goto :fail
)

rem Do not pass a direct OpenRouter key to the desktop. The proxy child
rem reloads it from .env; the desktop receives only PATHFORGE_PROXY_URL.
set "OPENROUTER_API_KEY="

if not exist "%DESKTOP_EXE%" (
  set "FAIL_REASON=The installed PathForge app was not found at %DESKTOP_EXE%."
  goto :fail
)

tasklist /FI "IMAGENAME eq PathForge.exe" 2>nul | find /I "PathForge.exe" >nul
if not errorlevel 1 (
  set "FAIL_REASON=PathForge is already running. Close it first so the new process inherits the proxy setting."
  goto :fail
)

rem If the proxy requires an app key, pass the same optional value to
rem the desktop process without exposing it in this window.
for /f "tokens=1,* delims==" %%A in ('findstr /B /C:"PATHFORGE_APP_KEY=" ".env" 2^>nul') do set "PATHFORGE_APP_KEY=%%B"

powershell.exe -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8080/healthz; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
if errorlevel 1 (
  echo [1/2] Building the LLM proxy...
  call pnpm --filter @workspace/llm-proxy run build
  if errorlevel 1 (
    set "FAIL_REASON=The LLM proxy build failed."
    goto :fail
  )

  echo Starting proxy at http://127.0.0.1:8080...
  start "PathForge LLM Proxy :8080" cmd.exe /k "set PORT=8080&& node --env-file=.env --enable-source-maps artifacts\llm-proxy\dist\index.mjs"

  powershell.exe -NoProfile -Command "$deadline = (Get-Date).AddSeconds(12); do { try { $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:8080/healthz; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $deadline); exit 1" >nul 2>&1
  if errorlevel 1 (
    set "FAIL_REASON=The proxy did not become healthy within 12 seconds. Check the proxy window."
    goto :fail
  )
) else (
  echo [1/2] A healthy proxy is already running at http://127.0.0.1:8080.
)

echo [2/2] Launching the installed PathForge desktop app...
rem Give the packaged app its installation folder as the working directory.
rem Older installed builds otherwise inspect the launcher's repository .env
rem and mistake the proxy's server key for a personal BYO key.
start "" /D "%DESKTOP_DIR%" "%DESKTOP_EXE%"

echo(
echo   Proxy  : http://127.0.0.1:8080
echo   Desktop: %DESKTOP_EXE%
echo(
echo The desktop app is running its own embedded API server.
echo Keep the proxy window open while using the free-tier proxy.
echo(
endlocal
exit /b 0

:fail
echo(
echo ERROR: %FAIL_REASON%
echo(
echo Startup cancelled. Fix the error above and run this file again.
echo(
pause
endlocal
exit /b 1
