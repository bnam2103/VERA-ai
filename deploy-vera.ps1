<#
.SYNOPSIS
  Deploy VERA frontend only (no backend) to GitHub Pages or Cloudflare Pages.

.DESCRIPTION
  Branch roles:
    main       -> GitHub Pages demo at https://bnam2103.github.io/VERA-ai/
    production -> workwithvera.com via Cloudflare Pages (auto-deploy on push)

  Backend (NOT deployed by this script):
    https://api.workwithvera.com  (Cloudflare Worker in vera-api/)
    Local Python API: server.py (+ app.py import shim) — never pushed by this script.

  Static files copied to the deploy clone ONLY:
    index.html, styles.css, product.css (if present), app/, config/, utils/,
    users/, voice/, workmode/, news/, debug/, and frontend media as needed.
  Never copied: server.py, app.py, actions/, auth/, CHAT*.py, TTS.py, tests/, etc.

  Workflow:
    1. Check out the correct branch in your SOURCE repo (Online_demo).
    2. Edit, git add, git commit locally.
    3. Run deploy-vera.ps1 with -Target github OR -Target production.

  Shared fixes across both sites:
    - Commit on one branch, cherry-pick onto the other, deploy each target separately.
    - This script does NOT merge, cherry-pick, or sync branches automatically.

  -Target both:
    Documentation-only. Explains how to deploy each site safely. Does not push.

.PARAMETER Target
  github     Deploy/push origin/main for the GitHub Pages demo.
  production Deploy/push origin/production for workwithvera.com (Cloudflare Pages).
  both       Print dual-deploy guidance only (no push).

.PARAMETER SourcePath
  Local repo where you edit and commit (default: Online_demo).

.PARAMETER ClonePath
  Git clone that pushes to github.com/bnam2103/VERA-ai (default: VERA-ai-git).

.PARAMETER Force
  Skip the uncommitted-changes confirmation prompt (not recommended).

.EXAMPLE
  git checkout main
  git commit -am "Demo: landing copy tweak"
  powershell -ExecutionPolicy Bypass -File ".\deploy-vera.ps1" -Target github

.EXAMPLE
  git checkout production
  git commit -am "Production: workwithvera.com hero"
  powershell -ExecutionPolicy Bypass -File ".\deploy-vera.ps1" -Target production
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("github", "production", "both")]
  [string]$Target,

  [string]$SourcePath = "C:\Users\User\Documents\VERA\Online_demo",
  [string]$ClonePath = "C:\Users\User\Documents\VERA-ai-git",
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Info([string]$Message) { Write-Host $Message -ForegroundColor Cyan }
function Write-Warn([string]$Message) { Write-Host $Message -ForegroundColor Yellow }
function Write-Err([string]$Message) { Write-Host $Message -ForegroundColor Red }
function Write-Ok([string]$Message) { Write-Host $Message -ForegroundColor Green }

function ConvertTo-GitText {
  param([object]$Raw)
  if ($null -eq $Raw) { return "" }
  if ($Raw -is [string]) { return $Raw }
  if ($Raw -is [System.Management.Automation.ErrorRecord]) { return $Raw.ToString() }
  if ($Raw -is [System.Collections.IEnumerable]) {
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($item in $Raw) {
      if ($null -eq $item) { continue }
      if ($item -is [System.Management.Automation.ErrorRecord]) {
        $parts.Add($item.ToString())
      }
      else {
        $parts.Add([string]$item)
      }
    }
    return ($parts -join "`n")
  }
  return [string]$Raw
}

function Invoke-Git {
  param(
    [string]$RepoPath,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$GitArgs
  )
  if (-not $RepoPath) { throw "Invoke-Git: RepoPath is required." }
  if (-not $GitArgs -or $GitArgs.Count -eq 0) { throw "Invoke-Git: git arguments are required." }

  Push-Location $RepoPath
  try {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $out = & git @GitArgs 2>&1
      $exitCode = $LASTEXITCODE
    }
    finally {
      $ErrorActionPreference = $prevEap
    }
    $text = ConvertTo-GitText $out
    if ($exitCode -ne 0) {
      $cmd = "git $($GitArgs -join ' ')"
      $detail = if ($text) { $text } else { "(no output)" }
      throw "${cmd} failed in ${RepoPath} (exit ${exitCode})`n${detail}"
    }
    return $text
  }
  finally {
    Pop-Location
  }
}

function Get-RepoBranch([string]$RepoPath) {
  $branch = Invoke-Git $RepoPath rev-parse --abbrev-ref HEAD
  if ([string]::IsNullOrWhiteSpace($branch)) {
    throw "git rev-parse --abbrev-ref HEAD returned empty output in ${RepoPath}"
  }
  return $branch.Trim()
}

function Get-RepoStatus([string]$RepoPath) {
  return Invoke-Git $RepoPath status --short --branch
}

function Test-RepoDirty([string]$RepoPath) {
  $porcelain = Invoke-Git $RepoPath status --porcelain
  return -not [string]::IsNullOrWhiteSpace($porcelain)
}

function Confirm-Continue([string]$Prompt) {
  if ($script:Force) { return $true }
  $answer = Read-Host "$Prompt [y/N]"
  if ($null -eq $answer) { return $false }
  $answer = [string]$answer
  if ([string]::IsNullOrWhiteSpace($answer)) { return $false }
  return ($answer -match '^(y|yes)$')
}

function Show-BothTargetGuidance {
  Write-Warn ""
  Write-Warn "=== -Target both does NOT push automatically ==="
  Write-Warn ""
  Write-Info "You cannot deploy both sites from a single branch checkout."
  Write-Info "Shared changes must exist on BOTH branches before deploying each target."
  Write-Info ""
  Write-Info "Recommended flow for a shared app fix (e.g. app/app.js):"
  Write-Info "  1. git checkout main"
  Write-Info "     # edit shared files, commit"
  Write-Info "     git add app/ config/ users/ voice/ workmode/ news/ debug/"
  Write-Info "     git commit -m ""Fix: shared app behavior"""
  Write-Info "     .\deploy-vera.ps1 -Target github"
  Write-Info ""
  Write-Info "  2. git checkout production"
  Write-Info "     git cherry-pick <commit-sha-from-main>"
  Write-Info "     # resolve conflicts; keep production index.html/styles.css if needed"
  Write-Info "     .\deploy-vera.ps1 -Target production"
  Write-Info ""
  Write-Info "Deploy each target only from its own branch:"
  Write-Info "  main       -> -Target github     -> bnam2103.github.io/VERA-ai/"
  Write-Info "  production -> -Target production -> workwithvera.com (Cloudflare auto-deploy)"
  Write-Warn ""
}

function Copy-FrontendToClone {
  param([string]$Source, [string]$Clone)

  $required = @(
    "$Source\index.html",
    "$Source\styles.css",
    "$Source\app\index.html",
    "$Source\app\app.js",
    "$Source\app\shell.js"
  )
  foreach ($path in $required) {
    if (-not (Test-Path $path)) {
      throw "Required source file missing: $path"
    }
  }

  Copy-Item "$Source\index.html" $Clone -Force
  Copy-Item "$Source\styles.css" $Clone -Force
  if (Test-Path "$Source\product.css") {
    Copy-Item "$Source\product.css" $Clone -Force
  }

  New-Item -ItemType Directory -Path (Join-Path $Clone "app") -Force | Out-Null
  Copy-Item "$Source\app\index.html" (Join-Path $Clone "app\") -Force
  Copy-Item "$Source\app\app.js" (Join-Path $Clone "app\") -Force
  Copy-Item "$Source\app\shell.js" (Join-Path $Clone "app\") -Force

  foreach ($dir in @("config", "utils", "voice", "workmode", "news", "debug", "users")) {
    $srcDir = Join-Path $Source $dir
    if (-not (Test-Path $srcDir)) {
      throw "Required source directory missing: $srcDir"
    }
    $destDir = Join-Path $Clone $dir
    if (Test-Path $destDir) {
      Remove-Item $destDir -Recurse -Force
    }
    Copy-Item $srcDir $destDir -Recurse -Force
  }

  # Never publish a GitHub Pages CNAME from either frontend pipeline.
  $cname = Join-Path $Clone "CNAME"
  if (Test-Path $cname) {
    Remove-Item $cname -Force
    Write-Warn "Removed CNAME from deploy clone (custom domains are configured in host dashboards)."
  }
}

function Test-RemoteBranchExists {
  param([string]$RepoPath, [string]$RemoteBranch)
  try {
    Invoke-Git $RepoPath rev-parse --verify "origin/$RemoteBranch" | Out-Null
    return $true
  }
  catch {
    return $false
  }
}

function Deploy-FrontendTarget {
  param(
    [string]$BranchName,
    [string]$RemoteBranch,
    [string]$CommitMessage,
    [string]$SuccessMessage
  )

  if (-not (Test-Path $SourcePath)) {
    throw "Source repo not found: $SourcePath"
  }
  if (-not (Test-Path $ClonePath)) {
    throw "Deploy clone not found: $ClonePath`nClone https://github.com/bnam2103/VERA-ai there first."
  }

  $sourceBranch = Get-RepoBranch $SourcePath
  $sourceStatus = Get-RepoStatus $SourcePath

  Write-Info ""
  Write-Info "=== VERA frontend deploy ==="
  Write-Info "Target:       $Target"
  Write-Info "Source repo:  $SourcePath"
  Write-Info "Source branch:$sourceBranch"
  Write-Info "Deploy clone: $ClonePath"
  Write-Info "Remote branch:origin/$RemoteBranch"
  Write-Info ""
  Write-Info "Source git status:"
  if ([string]::IsNullOrWhiteSpace($sourceStatus)) {
    Write-Host "(clean)"
  }
  else {
    Write-Host $sourceStatus
  }
  Write-Info ""

  if ($sourceBranch -ne $BranchName) {
    Write-Err "STOP: Source repo is on '$sourceBranch', but -Target $Target requires branch '$BranchName'."
    Write-Err ""
    Write-Err "Fix:"
    Write-Err "  cd `"$SourcePath`""
    Write-Err "  git checkout $BranchName"
    Write-Err "  # commit your changes, then re-run deploy-vera.ps1 -Target $Target"
    exit 1
  }

  if (Test-RepoDirty $SourcePath) {
    Write-Warn "Source repo has uncommitted changes."
    Write-Warn "Deploy copies files from disk, not only the last commit."
    Write-Warn "Recommended: git add / git commit first so deploy matches a known commit."
    if (-not (Confirm-Continue "Continue deploy anyway?")) {
      Write-Err "Stopped. Commit or stash changes, then re-run."
      exit 1
    }
  }

  if (Test-RepoDirty $ClonePath) {
    Write-Warn "Deploy clone has uncommitted changes."
    if (-not (Confirm-Continue "Overwrite clone working tree and continue?")) {
      Write-Err "Stopped. Clean or stash changes in the deploy clone first."
      exit 1
    }
  }

  Write-Info "Fetching origin in deploy clone..."
  Invoke-Git $ClonePath fetch origin | Out-Null

  $remoteExists = Test-RemoteBranchExists -RepoPath $ClonePath -RemoteBranch $RemoteBranch

  if ($remoteExists) {
    Invoke-Git $ClonePath checkout $BranchName | Out-Null
    Invoke-Git $ClonePath pull origin $RemoteBranch | Out-Null
  }
  else {
    Write-Warn "Remote branch origin/$RemoteBranch not found. Creating local branch '$BranchName'."
    $currentCloneBranch = Get-RepoBranch $ClonePath
    if ($currentCloneBranch -ne $BranchName) {
      Invoke-Git $ClonePath checkout -b $BranchName | Out-Null
    }
  }

  Write-Info "Copying frontend files (no backend / Worker code)..."
  Copy-FrontendToClone -Source $SourcePath -Clone $ClonePath

  $cloneStatus = Get-RepoStatus $ClonePath
  Write-Info ""
  Write-Info "Deploy clone status after copy:"
  if ([string]::IsNullOrWhiteSpace($cloneStatus)) {
    Write-Host "(clean)"
  }
  else {
    Write-Host $cloneStatus
  }
  Write-Info ""

  $porcelain = Invoke-Git $ClonePath status --porcelain
  if ([string]::IsNullOrWhiteSpace($porcelain)) {
    Write-Warn "No file changes detected in deploy clone. Nothing to push."
    exit 0
  }

  if (-not (Confirm-Continue "Commit and push to origin/${RemoteBranch}?")) {
    Write-Err "Stopped before commit/push. Deploy clone has copied files but was not pushed."
    exit 1
  }

  $gitAdd = @("index.html", "styles.css", "app", "config", "utils", "voice", "workmode", "news", "debug", "users")
  if (Test-Path (Join-Path $Clone "product.css")) {
    $gitAdd = @("index.html", "styles.css", "product.css") + $gitAdd[2..($gitAdd.Length - 1)]
  }
  Invoke-Git $ClonePath add @gitAdd | Out-Null
  Invoke-Git $ClonePath commit -m $CommitMessage | Out-Null

  if ($remoteExists) {
    Invoke-Git $ClonePath push origin $RemoteBranch | Out-Null
  }
  else {
    Invoke-Git $ClonePath push -u origin $RemoteBranch | Out-Null
  }

  Write-Ok ""
  Write-Ok $SuccessMessage
  Write-Ok ""

  if ($Target -eq "production") {
    Write-Info "Cloudflare Pages: no manual deploy command needed if the project watches origin/production."
    Write-Info "Push triggers an automatic Cloudflare build/deploy for workwithvera.com."
  }
  elseif ($Target -eq "github") {
    Write-Info "GitHub Pages: no extra deploy command if Pages is set to branch 'main' / root."
    Write-Info "Do NOT attach workwithvera.com as a GitHub Pages custom domain."
  }
}

# --- entry ---

switch ($Target) {
  "both" {
    $sourceBranch = if (Test-Path $SourcePath) { Get-RepoBranch $SourcePath } else { "(source not found)" }
    $sourceStatus = if (Test-Path $SourcePath) { Get-RepoStatus $SourcePath } else { "" }
    Write-Info "Source repo:  $SourcePath"
    Write-Info "Source branch:$sourceBranch"
    if (-not [string]::IsNullOrWhiteSpace($sourceStatus)) {
      Write-Info "Source status:"
      Write-Host $sourceStatus
    }
    Show-BothTargetGuidance
    exit 0
  }
  "github" {
    Deploy-FrontendTarget `
      -BranchName "main" `
      -RemoteBranch "main" `
      -CommitMessage "Update GitHub Pages demo frontend" `
      -SuccessMessage "Pushed to origin/main for GitHub Pages: https://bnam2103.github.io/VERA-ai/"
  }
  "production" {
    Deploy-FrontendTarget `
      -BranchName "production" `
      -RemoteBranch "production" `
      -CommitMessage "Update workwithvera.com production frontend" `
      -SuccessMessage "Pushed to origin/production for Cloudflare Pages: https://workwithvera.com/"
  }
}
