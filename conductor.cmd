@echo off
set "ROOT=%~dp0"

IF "%1"==""         GOTO start
IF "%1"=="start"    GOTO start
IF "%1"=="s"        GOTO start
IF "%1"=="dev"      GOTO dev
IF "%1"=="build"    GOTO build
IF "%1"=="b"        GOTO build
IF "%1"=="restart"  GOTO restart
IF "%1"=="r"        GOTO restart
IF "%1"=="kill"     GOTO kill
IF "%1"=="k"        GOTO kill
IF "%1"=="status"   GOTO status
IF "%1"=="st"       GOTO status
IF "%1"=="package"  GOTO package
IF "%1"=="clean"    GOTO clean
IF "%1"=="version"  GOTO version
IF "%1"=="-v"       GOTO version
IF "%1"=="help"     GOTO help
IF "%1"=="-h"       GOTO help
GOTO help

:start
echo Starting Conductor desktop app...
cd /d "%ROOT%"
call npm run dev
GOTO end

:dev
echo Starting Conductor in dev mode...
cd /d "%ROOT%"
call npm run dev
GOTO end

:build
echo Building Conductor...
cd /d "%ROOT%"
call npm run build
echo Done.
GOTO end

:package
echo Packaging Conductor for distribution...
cd /d "%ROOT%"
call npm run package
GOTO end

:restart
echo Restarting Conductor...
taskkill /f /im conductor.exe >nul 2>&1
timeout /t 2 /nobreak >nul
cd /d "%ROOT%"
call npm run dev
GOTO end

:kill
echo Stopping all Conductor processes...
taskkill /f /im conductor.exe >nul 2>&1
taskkill /f /im electron.exe >nul 2>&1
echo Done.
GOTO end

:status
echo Conductor Process Status:
tasklist /fi "imagename eq electron.exe" 2>nul | findstr /i "electron" >nul
if %errorlevel% equ 0 (
    tasklist /fi "imagename eq electron.exe" /fo table 2>nul | findstr /i "electron"
    echo Status: RUNNING
) else (
    echo Status: STOPPED
)
GOTO end

:clean
echo Cleaning build artifacts...
if exist "%ROOT%out" (
    rmdir /s /q "%ROOT%out" 2>nul
    echo Removed out/
)
if exist "%ROOT%dist\daemon" (
    rmdir /s /q "%ROOT%dist\daemon" 2>nul
    echo Removed dist/daemon/
)
if exist "%ROOT%dist\webui" (
    rmdir /s /q "%ROOT%dist\webui" 2>nul
    echo Removed dist/webui/
)
if exist "%ROOT%release" (
    rmdir /s /q "%ROOT%release" 2>nul
    echo Removed release/
)
echo Done.
GOTO end

:version
echo Conductor v2.0.0
GOTO end

:help
echo.
echo   Conductor v2.0.0 - Electron Agent Workbench
echo.
echo   Usage: conductor [command]
echo.
echo     start,   s    Launch desktop app (default)
echo     dev           Dev mode (with hot reload)
echo     build,  b    Build for production
echo     package       Package .exe installer
echo     restart,r    Kill all and relaunch
echo     kill,   k    Stop all processes
echo     status, st   Show running status
echo     clean        Remove build artifacts
echo     version,-v   Show version
echo     help,   -h   Show this help
echo.
echo   Examples:
echo     conductor          Launch desktop app
echo     conductor build    Build for production
echo     conductor package  Build .exe installer
echo     conductor status   Check status
echo     conductor kill     Stop all
echo.
GOTO end

:end
