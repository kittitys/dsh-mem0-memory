@echo off
REM ============================================================
REM  dsh-mem0-memory - start local mem0 server (Windows)
REM  Usage: start-server.bat [port]        (default 18200)
REM  Starts server in a background window, polls /health until
REM  healthy, then prints status. Stop: close "mem0-server" window
REM  or run: taskkill /fi "WINDOWTITLE eq mem0-server"
REM ============================================================
setlocal enabledelayedexpansion

set PORT=%~1
if "%PORT%"=="" set PORT=18200
set DIR=%~dp0

REM quick dependency check
python -c "import mem0, jieba, flask" >nul 2>&1
if errorlevel 1 (
  echo [start-server] dependencies missing - run: python setup.py --init --install
  exit /b 1
)

echo [start-server] starting mem0-server on port %PORT% ...
start "mem0-server" /min python "%DIR%mem0-server.py" --port %PORT%

REM health self-check: wait up to 120s
set /a tries=0
:waitloop
set /a tries+=1
if %tries% gtr 60 (
  echo [start-server] FAIL: /health timeout after 120s, check server log
  exit /b 1
)
ping -n 3 127.0.0.1 >nul
curl -s -m 3 "http://127.0.0.1:%PORT%/health" 2>nul | findstr "healthy" >nul
if errorlevel 1 (
  curl -s -m 3 "http://127.0.0.1:%PORT%/health" 2>nul | findstr "init_failed" >nul
  if not errorlevel 1 (
    echo [start-server] FAIL: init failed
    exit /b 1
  )
  echo [start-server] initializing... tries=!tries!
  goto waitloop
)

echo [start-server] OK: healthy, port %PORT% - server running in background window
echo [start-server] stop: close "mem0-server" window, or  taskkill /fi "WINDOWTITLE eq mem0-server"
endlocal
