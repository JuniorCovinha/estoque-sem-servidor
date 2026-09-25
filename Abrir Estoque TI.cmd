@echo off
rem Abre o Estoque TI no Google Chrome (ou no Microsoft Edge, se o Chrome nao estiver instalado).
rem Funciona em qualquer pasta: usa o index.html que esta ao lado deste arquivo.
setlocal
set "APP=%~dp0index.html"
set "NAV="

for /f "tokens=2,*" %%A in ('reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve 2^>nul ^| find "REG_SZ"') do set "NAV=%%B"
if not defined NAV for /f "tokens=2,*" %%A in ('reg query "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve 2^>nul ^| find "REG_SZ"') do set "NAV=%%B"
if not defined NAV if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "NAV=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined NAV if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "NAV=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined NAV if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "NAV=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined NAV if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "NAV=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined NAV if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "NAV=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if not defined NAV (
  echo Google Chrome nao encontrado neste computador.
  echo Instale o Chrome ou abra o arquivo index.html pelo Chrome/Edge manualmente.
  pause
  exit /b 1
)
if not exist "%APP%" (
  echo Arquivo index.html nao encontrado ao lado deste atalho: "%APP%"
  pause
  exit /b 1
)
start "" "%NAV%" "%APP%"
