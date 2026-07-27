@echo off
rem ============================================================
rem  PathForge - local dev mode (no login, hot reload)
rem  Double-click this file. It opens two windows:
rem    - Backend  http://localhost:5000  (auto-rebuilds on change)
rem    - App      http://localhost:3000  (Vite hot-reload)
rem  Uses a separate dev DB so your installed app's data is untouched.
rem ============================================================
setlocal
cd /d "%~dp0"

rem --- local single-user mode + a dedicated dev database ---
set PATHFORGE_LOCAL_MODE=1
set PATHFORGE_LOCAL_DB=%USERPROFILE%\pathforge-dev-db
set PATHFORGE_MIGRATIONS_DIR=%~dp0lib\db\drizzle
set VITE_LOCAL_MODE=1

echo(
echo   Starting PathForge dev mode...
echo     backend : http://localhost:5000   (first build takes ~15s)
echo     app     : http://localhost:3000
echo     dev DB  : %PATHFORGE_LOCAL_DB%
echo(
echo   Your OpenRouter key is read from .env, or add it in Profile -^> Settings.
echo   Close either window (or Ctrl+C) to stop that server.
echo(

start "PathForge Backend :5000" cmd /k pnpm --filter @workspace/api-server run dev
start "PathForge App :3000" cmd /k pnpm --filter @workspace/app run dev

rem give the backend time to build before opening the browser
timeout /t 18 /nobreak >nul
start "" http://localhost:3000

echo   Opened http://localhost:3000 - if it is blank, wait a few seconds and refresh
echo   (the backend is still building on the first run).
endlocal
