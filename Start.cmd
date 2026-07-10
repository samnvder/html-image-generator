@echo off
rem Double-click to launch. Installs deps on first run, then opens the app.
cd /d "%~dp0"
if not exist "node_modules" (
  echo First run - installing dependencies...
  call npm install || goto :fail
)
npm start
goto :eof

:fail
echo.
echo Install failed. Is Node.js 20+ installed?
pause
