#!/bin/bash
# 9Router Portable ACP Runner for Devin Desktop (Linux/macOS)
cd "$(dirname "$0")"

if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed or not in PATH!"
    echo "Please install Node.js (v18+) from https://nodejs.org"
    exit 1
fi

node server.js
