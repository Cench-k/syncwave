@echo off
REM ---------------------------------------------------------------------------
REM Start SyncWave locally, with the CapCut integration enabled.
REM
REM The /capcut routes read and write files anywhere on this machine, so they
REM only exist when SYNCWAVE_LOCAL is set. The hosted HuggingFace build never
REM sets it and therefore never registers them.
REM
REM Usage:  run-local.bat           first run builds the UI, later runs reuse it
REM         run-local.bat rebuild   force a fresh UI build after code changes
REM
REM Keep this file ASCII-only. cmd.exe reads .bat in the system ANSI codepage,
REM so UTF-8 Korean text here is decoded as mojibake and then executed as
REM commands -- which is exactly how the first version of this script failed.
REM ---------------------------------------------------------------------------

setlocal
cd /d "%~dp0"

if not exist "backend\.venv\Scripts\python.exe" goto :no_venv

REM The backend serves the built frontend from backend\static. That folder is
REM produced by the Docker build, so a local checkout has to build it once.
set NEED_BUILD=
if /i "%~1"=="rebuild" set NEED_BUILD=1
if not exist "backend\static\index.html" set NEED_BUILD=1
if not defined NEED_BUILD goto :run

where npm >nul 2>nul
if errorlevel 1 goto :no_npm

pushd frontend
if exist "node_modules" goto :build
echo === Installing dependencies (first run only) ===
call npm install --no-audit --no-fund
if errorlevel 1 goto :build_failed

:build
echo === Building UI (about 30 seconds) ===
REM Empty API base => same-origin calls, so the page talks to this backend.
set NEXT_PUBLIC_API_BASE=
call npm run build
if errorlevel 1 goto :build_failed
popd

if exist "backend\static" rmdir /s /q "backend\static"
xcopy /e /i /q /y "frontend\out" "backend\static" >nul
if errorlevel 1 goto :copy_failed
echo === Build complete ===

:run
set SYNCWAVE_LOCAL=1
if "%WHISPER_MODEL%"=="" set WHISPER_MODEL=medium
if "%WHISPER_DEVICE%"=="" set WHISPER_DEVICE=cpu
if "%WHISPER_COMPUTE%"=="" set WHISPER_COMPUTE=int8
REM Set CAPCUT_DRAFT_ROOT if CapCut keeps drafts somewhere non-default.

echo.
echo   SyncWave [local]  model=%WHISPER_MODEL%  device=%WHISPER_DEVICE%
echo   http://localhost:8000
echo   Closing this window stops the server.
echo.
REM Open the browser a few seconds later, detached, so it does not race uvicorn.
start "" /min cmd /c "timeout /t 4 >nul & start "" http://localhost:8000"
cd backend
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
goto :eof

:no_venv
echo [!] backend\.venv not found. Create it first:
echo       cd backend
echo       python -m venv .venv
echo       .venv\Scripts\python.exe -m pip install -r requirements.txt
pause
exit /b 1

:no_npm
echo [!] npm not found. Install Node.js, or run "npm run dev" in frontend\
echo     separately and use http://localhost:3000 instead.
pause
exit /b 1

:build_failed
popd
echo [!] UI build failed.
pause
exit /b 1

:copy_failed
echo [!] Could not copy frontend\out to backend\static.
pause
exit /b 1
