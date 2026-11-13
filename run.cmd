@echo off
cd /d "%~dp0"
node bin/run.js
if errorlevel 1 pause
