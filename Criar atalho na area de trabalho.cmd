@echo off
rem Cria na area de trabalho um atalho "Estoque TI" que abre esta aplicacao direto no Google Chrome.
rem Rode uma vez depois de colocar a pasta da aplicacao no lugar definitivo (se mover a pasta, rode de novo).
setlocal
set "APP=%~dp0index.html"
if not exist "%APP%" (
  echo Arquivo index.html nao encontrado ao lado deste arquivo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$app = $env:APP;" ^
  "$cands = @();" ^
  "foreach ($k in 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe') { try { $cands += (Get-ItemProperty -LiteralPath $k -ErrorAction Stop).'(default)' } catch {} };" ^
  "$cands += \"$env:ProgramFiles\Google\Chrome\Application\chrome.exe\", \"${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe\", \"$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe\";" ^
  "$nav = $cands | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1;" ^
  "if (-not $nav) { Write-Host 'Google Chrome nao encontrado. Instale o Chrome e rode este arquivo de novo.'; exit 1 };" ^
  "$desk = [Environment]::GetFolderPath('Desktop');" ^
  "$lnk = Join-Path $desk 'Estoque TI.lnk';" ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk);" ^
  "$s.TargetPath = $nav;" ^
  "$s.Arguments = '\"' + $app + '\"';" ^
  "$s.WorkingDirectory = Split-Path -Parent $app;" ^
  "$s.IconLocation = $nav + ',0';" ^
  "$s.Description = 'Estoque TI - Solar Cuidados';" ^
  "$s.Save();" ^
  "Write-Host ('Atalho criado: ' + $lnk)"

if errorlevel 1 (
  pause
  exit /b 1
)
echo.
echo Pronto. Use o atalho "Estoque TI" na area de trabalho.
pause
