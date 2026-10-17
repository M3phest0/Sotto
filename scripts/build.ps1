$ErrorActionPreference = "Stop"

Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw "pnpm is required. Install Node 20+ and run: corepack enable"
}

Write-Host "Installing dependencies..."
pnpm install

Write-Host "Running unit tests..."
pnpm test

Write-Host "Building frontend..."
pnpm build

Write-Host "Building Windows bundles..."
pnpm tauri build

Write-Host ""
Write-Host "Artifacts are under src-tauri/target/release/bundle."
