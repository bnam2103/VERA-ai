<#
.SYNOPSIS
  Create a second checkout of this repo for backend work (production branch).

.DESCRIPTION
  Backend/system code has ONE source of truth on the production branch.
  This worktree lets you run uvicorn and edit Python without switching away
  from main when working on the GitHub Pages demo frontend.

  Result:
    ..\Online_demo-backend\  →  production branch, server.py, actions/, auth/, ...

  Launch API:
    cd ..\Online_demo-backend
    py -m uvicorn server:app --host 0.0.0.0 --port 8000

.PARAMETER WorktreePath
  Where to create the backend checkout (default: sibling Online_demo-backend).

.PARAMETER Branch
  Branch that holds canonical backend (default: production).
#>
[CmdletBinding()]
param(
  [string]$WorktreePath = "",
  [string]$Branch = "production"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (git rev-parse --show-toplevel).Trim()
if (-not $WorktreePath) {
  $parent = Split-Path $repoRoot -Parent
  $WorktreePath = Join-Path $parent "Online_demo-backend"
}

Write-Host "Repo root:     $repoRoot"
Write-Host "Worktree path: $WorktreePath"
Write-Host "Branch:        $Branch"
Write-Host ""

if (Test-Path $WorktreePath) {
  $existing = (git -C $WorktreePath rev-parse --is-inside-work-tree 2>$null)
  if ($existing -eq "true") {
    Write-Host "Worktree already exists. Pull latest:"
    Write-Host "  cd `"$WorktreePath`""
    Write-Host "  git pull origin $Branch"
    exit 0
  }
  throw "Path exists but is not a git worktree: $WorktreePath"
}

git fetch origin $Branch
git worktree add $WorktreePath $Branch

Write-Host ""
Write-Host "Backend worktree ready."
Write-Host ""
Write-Host "  cd `"$WorktreePath`""
Write-Host "  copy .env.example .env   # if needed"
Write-Host "  py -m pip install -r requirements.txt"
Write-Host "  py -m uvicorn server:app --host 0.0.0.0 --port 8000"
Write-Host ""
Write-Host "Edit backend only in this folder. Push to origin $Branch."
Write-Host "Do not copy Python files onto main - use this worktree."
