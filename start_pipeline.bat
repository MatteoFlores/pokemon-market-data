@echo off
cd /d "%~dp0"
title Pokemon Market Data - Launcher

echo.
echo  ==========================================
echo   Pokemon Market Data Pipeline Launcher
echo  ==========================================
echo.

REM ── Preflight checks ──────────────────────────────────────────────────────────

if not exist "node_modules" (
    echo  Installing Node dependencies...
    call npm install
    echo.
)

if not exist "venv\Scripts\activate.bat" (
    echo  ERROR: Python venv not found.
    echo  Run this first:
    echo    python -m venv venv
    echo    venv\Scripts\activate
    echo    pip install -r requirements.txt
    echo.
    pause
    exit /b 1
)

if not exist "models\grading_labels.pt" (
    echo  ERROR: Model not found at models\grading_labels.pt
    echo  Run train_label_detector.py first.
    echo.
    pause
    exit /b 1
)

REM ── Launch each process in its own window ─────────────────────────────────────

echo  [1/3] Starting dashboard...
start "Dashboard ^ localhost:3000" cmd /k "node dashboard.js"
timeout /t 2 /nobreak >nul

echo  [2/3] Starting scraper (2 scrape workers + 3 image workers)...
start "Scraper ^ scrape_sold_with_images" cmd /k "node scrape_sold_with_images.js all 2 3"

echo  [3/3] Starting cert extractor (YOLO + OCR)...
start "Cert Extractor ^ extract_certs" cmd /k "call venv\Scripts\activate.bat && python extract_certs.py --watch"

timeout /t 2 /nobreak >nul

echo  Opening dashboard...
start http://localhost:3000

echo.
echo  ==========================================
echo   All 3 processes running in separate windows.
echo   Dashboard: http://localhost:3000
echo  ==========================================
echo.
