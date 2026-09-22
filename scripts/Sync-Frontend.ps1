# Syncs ONLY frontend paths to the partner repo (DIBBLS/Unify, upstream).
# Backend (notes-engine, supabase, render.yaml, docs) stays on the fork (origin).
# Usage: powershell -ExecutionPolicy Bypass -File scripts/Sync-Frontend.ps1 [-Message "msg"]
param([string]$Message = ("chore: frontend sync " + (Get-Date -Format "yyyy-MM-dd HH:mm")))

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$prev = Get-Location
try {
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("unify-frontend-" + [System.Guid]::NewGuid().ToString("N"))
  git clone --depth 1 https://github.com/DIBBLS/Unify.git $tmp

  # Frontend-only allowlist (everything Vercel needs, nothing else)
  $appSrc = Join-Path $root "apps/web"
  $appDst = Join-Path $tmp "apps/web"
  robocopy $appSrc $appDst /MIR /XD node_modules dist /XF .env .env.* /NJH /NJS /NDL /NFL /NP | Out-Null
  foreach ($f in @("vercel.json", ".gitignore", "README.md")) {
    $s = Join-Path $root $f
    if (Test-Path -LiteralPath $s) { Copy-Item -Path $s -Destination (Join-Path $tmp $f) -Force }
  }

  # Drop backend leftovers + local-only files if present upstream
  foreach ($d in @("notes-engine", "supabase", "render.yaml", "SETUP.md", "COLLAB.md", "messages.unify.txt")) {
    $p = Join-Path $tmp $d
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
  }

  Set-Location -LiteralPath $tmp
  git add -A
  $dirty = git status --porcelain
  if ($dirty) {
    git commit -m $Message
    git push origin main
    Write-Output "frontend synced to DIBBLS/Unify"
  } else {
    Write-Output "frontend: no changes to sync"
  }
}
finally {
  Set-Location -LiteralPath $prev
  if ($tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Recurse -Force }
}
