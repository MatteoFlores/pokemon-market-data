@echo off
cd /d "%~dp0"
title Pokemon Scraper

if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    echo.
)

if not exist "config.json" (
    echo First time setup required. Running setup wizard...
    echo.
    node setup.js
    echo.
)

echo Starting scraper...
node scrape_sold_with_images.js
pause
