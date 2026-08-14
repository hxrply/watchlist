@echo off
rem Double-click this to publish the app to GitHub Pages.
rem First run creates the repo and turns Pages on; later runs just push.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1"
