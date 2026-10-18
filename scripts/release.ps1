<#
.SYNOPSIS
  Releases Claudia Desktop and Claudia Web together.

.DESCRIPTION
  Bumps the version of both apps (package.json and web/package.json), commits
  it on main, tags it vX.Y.Z and pushes both. The tag starts the Build and
  Release workflow on GitHub, which builds the Windows installer and the
  Claudia Web air-gap bundle, attaches them to one GitHub release and
  publishes it once both are done.

.PARAMETER Version
  patch, minor, major or an exact version such as 0.11.0. Asked for when
  left out.

.PARAMETER Yes
  Don't ask before pushing.

.EXAMPLE
  npm run release

.EXAMPLE
  npm run release -- -Version minor
#>
[CmdletBinding()]
param(
  [string]$Version,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Stop-Release([string]$Message) {
  Write-Host ''
  Write-Host "[ERROR] $Message" -ForegroundColor Red
  Write-Host ''
  exit 1
}

# Runs git or npm; Windows PowerShell turns their stderr into errors under 'Stop'
function Invoke-Native([string]$What, [scriptblock]$Command) {
  $ErrorActionPreference = 'Continue'
  & $Command
  if ($LASTEXITCODE -ne 0) { Stop-Release "$What failed (exit code $LASTEXITCODE)." }
}

function Get-Bumped([string]$Current, [string]$Kind) {
  $v = [version]($Current -replace '-.*$', '')
  switch ($Kind) {
    'patch' { return "$($v.Major).$($v.Minor).$($v.Build + 1)" }
    'minor' { return "$($v.Major).$($v.Minor + 1).0" }
    'major' { return "$($v.Major + 1).0.0" }
  }
}

$repo = (git rev-parse --show-toplevel)
if ($LASTEXITCODE -ne 0) { Stop-Release 'Run this inside the Claudia repository.' }
Set-Location $repo

Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host '   Claudia Release (desktop and web)' -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ''

# --- Checks -------------------------------------------------------------------

$status = git status --porcelain
if ($status) {
  Write-Host 'Commit or stash these changes first:' -ForegroundColor Yellow
  git status --short
  Stop-Release 'The working directory is not clean.'
}

$branch = git rev-parse --abbrev-ref HEAD
if ($branch -ne 'main') { Stop-Release "Releases are made from main; this checkout is on '$branch'. Run: git switch main" }

Write-Step 'Fetching origin'
Invoke-Native 'git fetch' { git fetch --tags --quiet origin }
$behind = [int](git rev-list --count HEAD..origin/main)
if ($behind -gt 0) { Stop-Release "main is $behind commit(s) behind origin/main. Run: git pull" }
$ahead = [int](git rev-list --count origin/main..HEAD)

# --- Version ------------------------------------------------------------------

$current = node -p "require('./package.json').version"
$webCurrent = node -p "require('./web/package.json').version"
Write-Host ''
Write-Host "Current version: $current (web/package.json: $webCurrent)" -ForegroundColor Yellow
Write-Host ''

if (-not $Version) {
  Write-Host 'Select version bump type:' -ForegroundColor Cyan
  Write-Host "  1) patch ($current -> $(Get-Bumped $current 'patch'))"
  Write-Host "  2) minor ($current -> $(Get-Bumped $current 'minor'))"
  Write-Host "  3) major ($current -> $(Get-Bumped $current 'major'))"
  Write-Host '  4) custom version'
  Write-Host ''
  switch (Read-Host 'Enter choice (1-4)') {
    '1' { $Version = 'patch' }
    '2' { $Version = 'minor' }
    '3' { $Version = 'major' }
    '4' { $Version = Read-Host 'Enter custom version (e.g., 0.11.0)' }
    default { Stop-Release 'Invalid choice.' }
  }
}

if ($Version -in @('patch', 'minor', 'major')) {
  $newVersion = Get-Bumped $current $Version
} else {
  $newVersion = $Version -replace '^v', ''
}
if ($newVersion -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { Stop-Release "'$newVersion' is not a version like 0.11.0." }
$tag = "v$newVersion"

if (git tag --list $tag) { Stop-Release "Tag $tag already exists." }
if (git ls-remote --tags origin "refs/tags/$tag") { Stop-Release "Tag $tag already exists on origin." }

Write-Host ''
Write-Host "  Release    $tag (desktop and web)"
if ($ahead -gt 0) { Write-Host "  Also pushes $ahead local commit(s) on main that are not on origin yet" -ForegroundColor Yellow }
Write-Host ''
if (-not $Yes) {
  $answer = Read-Host "Bump to $newVersion, push main and $tag, and start the release? (y/N)"
  if ($answer -notmatch '^(y|yes)$') { Stop-Release 'Cancelled; nothing was changed.' }
}

# --- Bump, commit, tag, push --------------------------------------------------

Write-Step "Setting the version to $newVersion"
Invoke-Native 'npm version' { npm version $newVersion --no-git-tag-version --allow-same-version }
Invoke-Native 'npm version (web)' { npm version $newVersion --no-git-tag-version --allow-same-version --prefix web }

Write-Step 'Committing the version bump'
Invoke-Native 'git add' { git add package.json package-lock.json web/package.json web/package-lock.json }
Invoke-Native 'git commit' { git commit --quiet -m "chore: release $tag" }

Write-Step "Creating tag $tag"
Invoke-Native 'git tag' { git tag -a $tag -m "Release $tag" }

Write-Step 'Pushing main and the tag'
# Atomic: either both arrive or neither does, so a failed push leaves no half release
Invoke-Native 'git push' { git push --atomic origin main $tag }

# --- Done ---------------------------------------------------------------------

$repoPath = ''
if ((git config --get remote.origin.url) -match 'github\.com[:/](.+?/.+?)(\.git)?$') { $repoPath = $matches[1] }

Write-Host ''
Write-Host '========================================' -ForegroundColor Green
Write-Host "  Release $tag started" -ForegroundColor Green
Write-Host '========================================' -ForegroundColor Green
Write-Host ''
Write-Host 'GitHub Actions now builds the Windows installer and the Claudia Web'
Write-Host 'air-gap bundle. The release stays a draft until both are attached.'
if ($repoPath) {
  Write-Host ''
  Write-Host "  Progress   https://github.com/$repoPath/actions/workflows/release.yml" -ForegroundColor Blue
  Write-Host "  Release    https://github.com/$repoPath/releases/tag/$tag" -ForegroundColor Blue
}
if (Get-Command gh -ErrorAction SilentlyContinue) {
  Write-Host ''
  Write-Host 'Follow it here with:  gh run watch'
}
Write-Host ''
