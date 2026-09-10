#!/bin/bash
# Pemasangan Otomatis 9Router ACP untuk Devin Desktop (macOS / Linux)

cd "$(dirname "$0")"

echo "========================================================"
echo "  Pemasangan Otomatis 9Router ACP untuk Devin Desktop"
echo "========================================================"
echo ""

if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js tidak ditemukan di PATH!"
    echo "Silakan install Node.js (v18+) dari: https://nodejs.org"
    exit 1
fi

if [ ! -f .env ] && [ -f .env.example ]; then
    echo "[INFO] Membuat file .env dari .env.example..."
    cp .env.example .env
fi

node register.js
