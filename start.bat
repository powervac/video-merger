@echo off
cd /d "%~dp0"
where npm >nul 2>nul || (echo Node.js ne naiden. Ustanovite ego s https://nodejs.org & pause & exit /b 1)
if not exist node_modules call npm install
call npm start
if errorlevel 1 pause
