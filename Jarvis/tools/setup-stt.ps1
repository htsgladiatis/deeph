# Устанавливает локальное распознавание речи для Джарвиса:
# python-пакет vosk и русскую модель в Jarvis/models.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$here = Split-Path -Parent $PSScriptRoot
$models = Join-Path $here "models"
$modelName = "vosk-model-small-ru-0.22"
$modelDir = Join-Path $models $modelName

Write-Host "Джарвис: установка локального распознавания речи"

python --version | Out-Host
python -m pip install --upgrade --quiet vosk
if ($LASTEXITCODE -ne 0) { throw "Не удалось установить vosk. Проверьте Python и pip." }
Write-Host "  vosk установлен"

if (Test-Path $modelDir) {
  Write-Host "  модель уже на месте: $modelDir"
  exit 0
}

New-Item -ItemType Directory -Force $models | Out-Null
$zip = Join-Path $env:TEMP ($modelName + ".zip")
if (!(Test-Path $zip)) {
  $url = "https://alphacephei.com/vosk/models/" + $modelName + ".zip"
  Write-Host "  качаю модель (~45 МБ): $url"
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip -TimeoutSec 600
}
Write-Host "  распаковываю в $models"
Expand-Archive -Path $zip -DestinationPath $models -Force
Remove-Item $zip -Force -ErrorAction SilentlyContinue

if (!(Test-Path $modelDir)) { throw "Модель не распаковалась: $modelDir" }
Write-Host ""
Write-Host "Готово. Перезапустите Джарвис (jarvis.cmd) - речь теперь распознаётся локально."
