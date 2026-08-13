@echo off
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo Python was not found on PATH. Install it from https://python.org and try again.
    pause
    exit /b 1
)

rem serve.py finds its own free port and opens the browser to that exact port,
rem so it can never land on another local app. Close this window to stop it.
title Losinn's Watchlist Server (close this window to stop)
python serve.py
