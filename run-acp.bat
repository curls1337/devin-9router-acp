@echo off
setlocal enabledelayedexpansion

:: 9Router Portable ACP Runner for Devin Desktop
cd /d "%~dp0"

:: Check if node is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js (v18+) from https://nodejs.org
    pause
    exit /b 1
)

:: Run the ACP Server
node server.js
