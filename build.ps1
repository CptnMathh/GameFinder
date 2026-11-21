$ErrorActionPreference = 'Stop'
$pythonCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe'),
    (Join-Path $env:USERPROFILE 'AppData\Local\Programs\Python\Python313\python.exe')
)
$python = $pythonCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $python) { throw 'Python 3.13 introuvable. Installe Python puis relance build.ps1.' }
Set-Location $PSScriptRoot
& $python -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw "Installation des dépendances de GameFinder impossible." }
& $python -m pip install -r requirements-build.txt
if ($LASTEXITCODE -ne 0) { throw "Installation de PyInstaller impossible." }
& $python make_icon.py
if ($LASTEXITCODE -ne 0) { throw "Création de l'icône impossible." }
$buildArgs = @('-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile', '--windowed', '--name', 'GameFinder', '--icon', 'gamefinder.ico', '--add-data', 'web;web', '--collect-all', 'PIL', '--collect-all', 'pystray', '--hidden-import', 'ctypes.wintypes', 'main.py')
& $python @buildArgs
$outputName = 'GameFinder'
if ($LASTEXITCODE -ne 0) {
    Write-Warning 'GameFinder.exe est utilisé par Windows ; génération sous le nom GameFinder-Updated.exe.'
    $buildArgs[$buildArgs.IndexOf('GameFinder')] = 'GameFinder-Updated'
    & $python @buildArgs
    $outputName = 'GameFinder-Updated'
}
if ($LASTEXITCODE -ne 0) { throw 'La génération de GameFinder a échoué.' }
Write-Host "GameFinder généré : $PSScriptRoot\dist\$outputName.exe"
