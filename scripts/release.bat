@echo off
setlocal enabledelayedexpansion

echo.
echo ========================================
echo    Claudia Release Script
echo ========================================
echo.

REM Check if git working directory is clean
git diff-index --quiet HEAD --
if errorlevel 1 (
    echo [ERROR] Git working directory is not clean!
    echo.
    echo Please commit or stash your changes first:
    echo.
    git status --short
    echo.
    pause
    exit /b 1
)

REM Get current version
for /f "delims=" %%i in ('node -p "require('./package.json').version"') do set CURRENT_VERSION=%%i
echo Current version: %CURRENT_VERSION%
echo.

REM Ask for version type
echo Select version bump type:
echo   1) patch (0.1.0 -^> 0.1.1)
echo   2) minor (0.1.0 -^> 0.2.0)
echo   3) major (0.1.0 -^> 1.0.0)
echo   4) custom version
echo.

set /p CHOICE="Enter choice (1-4): "

if "%CHOICE%"=="1" set VERSION_TYPE=patch
if "%CHOICE%"=="2" set VERSION_TYPE=minor
if "%CHOICE%"=="3" set VERSION_TYPE=major
if "%CHOICE%"=="4" (
    set /p VERSION_TYPE="Enter custom version (e.g., 0.2.0): "
)

if "%VERSION_TYPE%"=="" (
    echo [ERROR] Invalid choice!
    pause
    exit /b 1
)

echo.
echo Updating version...
call npm version %VERSION_TYPE% --no-git-tag-version

if errorlevel 1 (
    echo [ERROR] Failed to update version!
    pause
    exit /b 1
)

REM Get new version
for /f "delims=" %%i in ('node -p "require('./package.json').version"') do set NEW_VERSION=%%i

echo.
echo Committing version bump...
git add package.json package-lock.json
git commit -m "chore: bump version to %NEW_VERSION%"

if errorlevel 1 (
    echo [ERROR] Failed to commit changes!
    pause
    exit /b 1
)

echo.
echo Creating tag v%NEW_VERSION%...
git tag -a "v%NEW_VERSION%" -m "Release v%NEW_VERSION%"

if errorlevel 1 (
    echo [ERROR] Failed to create tag!
    pause
    exit /b 1
)

echo.
echo Pushing to GitHub...
git push
git push --tags

if errorlevel 1 (
    echo [ERROR] Failed to push to GitHub!
    pause
    exit /b 1
)

echo.
echo ========================================
echo   SUCCESS! Release v%NEW_VERSION% triggered!
echo ========================================
echo.
echo Check GitHub Actions at:
echo https://github.com/YOUR_USERNAME/YOUR_REPO/actions
echo.
echo Replace YOUR_USERNAME/YOUR_REPO with your actual repo path
echo.
pause