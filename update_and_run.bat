@echo off
cd /d "%~dp0"
title Pokemon Scraper

:: ── Pull latest code from GitHub ─────────────────────────────────────────────
where git >nul 2>&1
if %errorlevel% equ 0 (
    echo Checking for updates...
    git pull
    echo.
) else (
    echo [WARN] git not found - skipping auto-update. Install git to get automatic updates.
    echo.
)

:: ── Install / update npm packages if needed ──────────────────────────────────
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    echo.
) else (
    :: Re-run install quietly in case package.json changed after a git pull
    call npm install --silent 2>nul
)

:: ── First-time setup (creates config.json with Google Sheets credentials) ────
if not exist "config.json" (
    echo First time setup required. Running setup wizard...
    echo.
    node setup.js
    echo.
)

:: ── Make sure the card catalog is present ────────────────────────────────────
if not exist "data\sets.json" (
    echo ERROR: data\sets.json is missing.
    echo Make sure you cloned the full repo from GitHub.
    pause
    exit /b 1
)

:: ── Run the scraper ───────────────────────────────────────────────────────────
echo Starting scraper...
node scrape_sold_with_images.js
pause
