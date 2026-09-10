@echo off
setlocal enabledelayedexpansion
title Setup 9Router ACP untuk Devin Desktop

cd /d "%~dp0"

echo ========================================================
echo   Pemasangan Otomatis 9Router ACP untuk Devin Desktop
echo ========================================================
echo.

:: 1. Cek ketersediaan Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js tidak ditemukan di sistem!
    echo.
    echo Silakan install Node.js (v18+) terlebih dahulu:
    echo Unduh di: https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: 2. Buat .env dari template jika belum ada
if not exist .env (
    if exist .env.example (
        echo [INFO] Membuat file .env dari .env.example...
        copy .env.example .env >nul
    )
)

:: 3. Jalankan pendaftaran otomatis
node register.js
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Terjadi kegagalan saat mendaftarkan 9Router ke Devin.
    pause
    exit /b 1
)

echo.
echo Selesai! Tekan sembarang tombol untuk keluar...
pause >nul
exit /b 0
