@echo off
REM ---------------------------------------------------------------------------
REM Package SyncWave as a folder anyone can unzip and run -- no Python, no
REM Node, no ffmpeg install on their side.
REM
REM Produces  dist\SyncWave\SyncWave.exe
REM
REM Keep this file ASCII-only: cmd.exe reads .bat in the system ANSI codepage,
REM so UTF-8 Korean text here would be executed as mojibake commands.
REM ---------------------------------------------------------------------------

setlocal
cd /d "%~dp0"

set PY=backend\.venv\Scripts\python.exe
if not exist "%PY%" goto :no_venv

REM --- 1. frontend -----------------------------------------------------------
where npm >nul 2>nul
if errorlevel 1 goto :no_npm

pushd frontend
if exist "node_modules" goto :fe_build
echo === Installing frontend dependencies ===
call npm install --no-audit --no-fund
if errorlevel 1 goto :fe_failed
:fe_build
echo === Building UI ===
set NEXT_PUBLIC_API_BASE=
call npm run build
if errorlevel 1 goto :fe_failed
popd

if exist "backend\static" rmdir /s /q "backend\static"
xcopy /e /i /q /y "frontend\out" "backend\static" >nul
if errorlevel 1 goto :copy_failed

REM --- 2. ffmpeg -------------------------------------------------------------
REM LGPL shared build: ffmpeg.exe is tiny and the DLLs total ~128MB, versus
REM ~213MB for a single statically linked exe. ffplay is dropped; it is 17MB
REM of video player we never call.
if exist "backend\ffmpeg\ffmpeg.exe" goto :have_ffmpeg
echo === Downloading ffmpeg (about 65MB, once) ===
"%PY%" tools\fetch_ffmpeg.py
if errorlevel 1 goto :ffmpeg_failed
:have_ffmpeg

REM --- 3. PyInstaller --------------------------------------------------------
"%PY%" -c "import PyInstaller" 2>nul
if errorlevel 1 "%PY%" -m pip install pyinstaller
if exist "dist\SyncWave" rmdir /s /q "dist\SyncWave"

echo === Packaging (takes a few minutes) ===
pushd backend
"..\%PY%" -m PyInstaller --noconfirm --distpath ..\dist --workpath ..\build syncwave.spec
if errorlevel 1 goto :pkg_failed
popd

REM Copy ffmpeg beside the exe rather than into the bundle: inside datas,
REM PyInstaller also scans the DLLs and duplicates them into _internal.
echo === Adding ffmpeg ===
xcopy /e /i /q /y "backend\ffmpeg" "dist\SyncWave\ffmpeg" >nul
if errorlevel 1 goto :copy_failed

echo.
echo === Done ===
echo   dist\SyncWave\SyncWave.exe
echo   Zip the dist\SyncWave folder and send that.
echo   Whisper downloads its model on first run (about 500MB for "small").
echo.
goto :eof

:no_venv
echo [!] backend\.venv not found. Create it first:
echo       cd backend
echo       python -m venv .venv
echo       .venv\Scripts\python.exe -m pip install -r requirements.txt
pause
exit /b 1

:no_npm
echo [!] npm not found. Install Node.js first.
pause
exit /b 1

:fe_failed
popd
echo [!] Frontend build failed.
pause
exit /b 1

:copy_failed
echo [!] Could not copy frontend\out to backend\static.
pause
exit /b 1

:ffmpeg_failed
echo [!] ffmpeg download failed. Put ffmpeg.exe and its DLLs in backend\ffmpeg\
echo     manually and run this again.
pause
exit /b 1

:pkg_failed
popd
echo [!] PyInstaller failed.
pause
exit /b 1
