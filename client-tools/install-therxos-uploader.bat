@echo off
setlocal enabledelayedexpansion

echo.
echo ============================================
echo   TheRxOS Auto-Uploader - Installer
echo ============================================
echo.
echo This tool will automatically upload CSV files
echo from your Desktop\TheRxOS folder to TheRxOS
echo every 30 minutes.
echo.

:: Prompt for API key
set /p API_KEY="Enter your TheRxOS API Key: "

if "%API_KEY%"=="" (
    echo.
    echo ERROR: API key is required. Contact stan@therxos.com for your key.
    pause
    exit /b 1
)

:: Set server URL (production)
set SERVER_URL=https://therxos-backend-production.up.railway.app

:: Create directories
set CONFIG_DIR=%APPDATA%\TheRxOS
set DESKTOP=%USERPROFILE%\Desktop
set WATCH_DIR=%DESKTOP%\TheRxOS
set SENT_DIR=%WATCH_DIR%\Sent

echo.
echo Creating folders...
if not exist "%CONFIG_DIR%" mkdir "%CONFIG_DIR%"
if not exist "%WATCH_DIR%" mkdir "%WATCH_DIR%"
if not exist "%SENT_DIR%" mkdir "%SENT_DIR%"

:: Save config
echo {"apiKey":"%API_KEY%","serverUrl":"%SERVER_URL%"} > "%CONFIG_DIR%\config.json"
echo   Config saved to %CONFIG_DIR%\config.json

:: Copy PowerShell script
set SCRIPT_DIR=%~dp0
set PS_SCRIPT=%SCRIPT_DIR%therxos-uploader.ps1

if exist "%PS_SCRIPT%" (
    copy /y "%PS_SCRIPT%" "%CONFIG_DIR%\therxos-uploader.ps1" > nul
    echo   Script copied to %CONFIG_DIR%\therxos-uploader.ps1
) else (
    echo.
    echo ERROR: therxos-uploader.ps1 not found in %SCRIPT_DIR%
    echo Make sure both files are in the same folder.
    pause
    exit /b 1
)

:: Create Windows Scheduled Task
echo.
echo Creating scheduled task (every 30 minutes)...

:: Delete existing task if it exists
schtasks /delete /tn "TheRxOS-AutoUpload" /f > nul 2>&1

:: Create the task - runs every 30 minutes, starts at login
schtasks /create /tn "TheRxOS-AutoUpload" /tr "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%CONFIG_DIR%\therxos-uploader.ps1\"" /sc minute /mo 30 /f > nul 2>&1

if %ERRORLEVEL% EQU 0 (
    echo   Scheduled task created successfully!
) else (
    echo   WARNING: Could not create scheduled task automatically.
    echo   You may need to run this installer as Administrator.
    echo.
    echo   Manual setup: Open Task Scheduler and create a task that runs:
    echo   powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "%CONFIG_DIR%\therxos-uploader.ps1"
    echo   Set it to repeat every 30 minutes.
)

:: Run it once now to test
echo.
echo Running initial test...
powershell.exe -ExecutionPolicy Bypass -File "%CONFIG_DIR%\therxos-uploader.ps1" 2>nul

echo.
echo ============================================
echo   Installation Complete!
echo ============================================
echo.
echo HOW TO USE:
echo   1. Export your PMS report as a CSV file
echo   2. Save it to: %WATCH_DIR%
echo   3. Within 30 minutes it will be automatically
echo      uploaded to TheRxOS
echo   4. Uploaded files are moved to: %SENT_DIR%
echo.
echo LOGS: %CONFIG_DIR%\upload.log
echo.
echo To uninstall, run:
echo   schtasks /delete /tn "TheRxOS-AutoUpload" /f
echo.

pause
