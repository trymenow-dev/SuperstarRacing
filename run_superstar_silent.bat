@echo off
SETLOCAL ENABLEDELAYEDEXPANSION

REM --- Paths ---
SET SERVER_DIR=%~dp0server_all_v2
SET ELECTRON_DIR=%~dp0electron_bundle
SET SERVER_FILE=server_all_v2.js
SET SERVER_URL=http://localhost:7100/public/queue_client.html

REM --- Step 1: Install server dependencies if missing ---
IF NOT EXIST "%SERVER_DIR%\node_modules" (
    cd /d "%SERVER_DIR%"
    npm install
)

REM --- Step 2: Start server in background silently ---
cd /d "%SERVER_DIR%"
start "" /MIN cmd /c "node "%SERVER_FILE%""

REM --- Step 3: Wait for server to respond ---
:CHECK_SERVER
powershell -Command "try { Invoke-WebRequest -UseBasicParsing -Uri '%SERVER_URL%' -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }"
IF %ERRORLEVEL% NEQ 0 (
    timeout /t 1 >nul
    goto CHECK_SERVER
)

REM --- Step 4: Launch Electron silently ---
cd /d "%ELECTRON_DIR%"
start "" /MIN cmd /c "npx electron main.js"

ENDLOCAL
