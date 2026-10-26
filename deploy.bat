@echo off
REM ENCLU homepage + contact API deploy (Windows)
REM Usage: run from D:\WWW_ROOT\ENCLU_EC_RENEWAL\enclu-homepage (or double-click)
REM Steps: git pull -> npm install (api) -> pm2 restart -> pm2 save

setlocal
cd /d "%~dp0"

echo [1/4] git pull origin main
git pull origin main
if errorlevel 1 goto fail

echo [2/4] npm install (api, production only)
cd api
call npm install --omit=dev
if errorlevel 1 goto fail

echo [3/4] pm2 restart enclu-contact-api
call pm2 delete enclu-contact-api >nul 2>&1
call pm2 start ecosystem.config.js
if errorlevel 1 goto fail

echo [4/4] pm2 save
call pm2 save
cd ..

echo done
endlocal
exit /b 0

:fail
echo deploy failed (see output above)
cd /d "%~dp0"
endlocal
exit /b 1
