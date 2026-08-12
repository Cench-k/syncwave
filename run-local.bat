@echo off
REM Start SyncWave with the CapCut integration enabled.
REM
REM The /capcut routes read and write files anywhere on this machine, so they
REM only exist when SYNCWAVE_LOCAL is set. The hosted HuggingFace build never
REM sets it and therefore never registers them.
REM
REM Serves the built frontend from backend\static when it exists; otherwise run
REM `npm run dev` in frontend\ separately and open http://localhost:3000.

setlocal
cd /d "%~dp0backend"

if not exist ".venv\Scripts\python.exe" (
    echo [!] backend\.venv 가 없습니다. 먼저 아래를 실행하세요:
    echo     cd backend ^&^& python -m venv .venv ^&^& .venv\Scripts\activate ^&^& pip install -r requirements.txt
    exit /b 1
)

set SYNCWAVE_LOCAL=1
if "%WHISPER_MODEL%"=="" set WHISPER_MODEL=medium
if "%WHISPER_DEVICE%"=="" set WHISPER_DEVICE=cpu
if "%WHISPER_COMPUTE%"=="" set WHISPER_COMPUTE=int8
REM Override CAPCUT_DRAFT_ROOT if CapCut stores drafts somewhere non-default.

echo SyncWave (local mode)  model=%WHISPER_MODEL%  device=%WHISPER_DEVICE%
echo   http://localhost:8000
echo.
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
