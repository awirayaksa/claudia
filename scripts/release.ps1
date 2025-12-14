Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   Claudia Release Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if git working directory is clean
$status = git status --porcelain
if ($status) {
    Write-Host "❌ Git working directory is not clean!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please commit or stash your changes first:" -ForegroundColor Yellow
    Write-Host ""
    git status --short
    Write-Host ""
    exit 1
}

# Get current version
$currentVersion = node -p "require('./package.json').version"
Write-Host "Current version: $currentVersion" -ForegroundColor Yellow
Write-Host ""

# Ask for version type
Write-Host "Select version bump type:" -ForegroundColor Cyan
Write-Host "  1) patch ($currentVersion -> " -NoNewline
$patchVer = node -p "const semver = require('semver'); semver.inc('$currentVersion', 'patch')" 2>$null
if ($patchVer) { Write-Host "$patchVer)" } else { Write-Host "x.x.x+1)" }
Write-Host "  2) minor ($currentVersion -> " -NoNewline
$minorVer = node -p "const semver = require('semver'); semver.inc('$currentVersion', 'minor')" 2>$null
if ($minorVer) { Write-Host "$minorVer)" } else { Write-Host "x.x+1.0)" }
Write-Host "  3) major ($currentVersion -> " -NoNewline
$majorVer = node -p "const semver = require('semver'); semver.inc('$currentVersion', 'major')" 2>$null
if ($majorVer) { Write-Host "$majorVer)" } else { Write-Host "x+1.0.0)" }
Write-Host "  4) custom version"
Write-Host ""

$choice = Read-Host "Enter choice (1-4)"

switch ($choice) {
    "1" { $versionType = "patch" }
    "2" { $versionType = "minor" }
    "3" { $versionType = "major" }
    "4" { 
        $versionType = Read-Host "Enter custom version (e.g., 0.2.0)"
    }
    default {
        Write-Host "❌ Invalid choice!" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "Updating version..." -ForegroundColor Cyan
npm version $versionType --no-git-tag-version

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to update version!" -ForegroundColor Red
    exit 1
}

# Get new version
$newVersion = node -p "require('./package.json').version"

Write-Host ""
Write-Host "Committing version bump..." -ForegroundColor Cyan
git add package.json package-lock.json
git commit -m "chore: bump version to $newVersion"

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to commit changes!" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Creating tag v$newVersion..." -ForegroundColor Cyan
git tag -a "v$newVersion" -m "Release v$newVersion"

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to create tag!" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Pushing to GitHub..." -ForegroundColor Cyan
git push
git push --tags

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to push to GitHub!" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  ✅ SUCCESS! Release v$newVersion triggered!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

# Try to get GitHub repo from git remote
$remoteUrl = git config --get remote.origin.url
if ($remoteUrl -match "github.com[:/](.+/.+?)(\.git)?$") {
    $repoPath = $matches[1] -replace '\.git$', ''
    Write-Host "Check GitHub Actions at:" -ForegroundColor Cyan
    Write-Host "https://github.com/$repoPath/actions" -ForegroundColor Blue
} else {
    Write-Host "Check GitHub Actions in your repository" -ForegroundColor Cyan
}
Write-Host ""