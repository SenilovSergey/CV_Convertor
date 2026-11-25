@echo off
setlocal
title CV Convertor
pushd "%~dp0" || goto :failed
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js and run this file again.
  pause
  popd
  exit /b 1
)
node ".\server.mjs" --open
set "cv_exit=%errorlevel%"
popd
if not "%cv_exit%"=="0" pause
exit /b %cv_exit%

:failed
echo Cannot open the application folder. Extract the ZIP and try again.
pause
exit /b 1
