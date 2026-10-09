$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
$previousDemo = $env:AFTERGLIDE_CLOUD_E2E
$previousSignedIn = $env:AFTERGLIDE_CLOUD_E2E_SIGNED_IN
$previousHeaded = $env:AFTERGLIDE_CLOUD_E2E_HEADED
try {
    $localRuntime = Join-Path $PSScriptRoot '.runtime\node-v24.14.0-win-x64\node.exe'
    $runtime = if (Test-Path -LiteralPath $localRuntime) { $localRuntime } else { (Get-Command node -ErrorAction Stop).Source }
    if (-not (Test-Path -LiteralPath 'dist\main\main.cjs')) {
        throw 'Build the project first with Node 24+: npm ci, then npm run build.'
    }
    $env:AFTERGLIDE_CLOUD_E2E = '1'
    $env:AFTERGLIDE_CLOUD_E2E_SIGNED_IN = '1'
    $env:AFTERGLIDE_CLOUD_E2E_HEADED = '1'
    & $runtime 'node_modules\electron\cli.js' '.'
} finally {
    $env:AFTERGLIDE_CLOUD_E2E = $previousDemo
    $env:AFTERGLIDE_CLOUD_E2E_SIGNED_IN = $previousSignedIn
    $env:AFTERGLIDE_CLOUD_E2E_HEADED = $previousHeaded
    Pop-Location
}
