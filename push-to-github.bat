@echo off
echo ========================================
echo GHOST ENGINE - DEPLOY TO GITHUB
echo ========================================
echo.
echo This script will:
echo 1. Initialize Git repository
echo 2. Add all files
echo 3. Commit with initial message
echo 4. Push to GitHub
echo.
pause

echo.
echo [1/5] Initializing Git repository...
git init
if %errorlevel% neq 0 (
    echo ERROR: Git initialization failed!
    pause
    exit /b 1
)

echo [2/5] Configuring Git user...
git config user.name "ghostdriveg1"
git config user.email "ghostdriveg1@users.noreply.github.com"

echo [3/5] Adding all files...
git add .

echo [4/5] Creating commit...
git commit -m "Initial commit: Ghost Drive Cloud Engine"

echo [5/5] Pushing to GitHub...
git remote remove origin 2>nul
git remote add origin https://github.com/ghostdriveg1/ghost-engine.git
git branch -M main

echo.
echo ========================================
echo GITHUB AUTHENTICATION
echo ========================================
echo When prompted for password, use your GitHub Personal Access Token
echo (NOT your GitHub password)
echo.
echo Generate token at: https://github.com/settings/tokens
echo Required scope: "repo" (full control of private repositories)
echo.
pause

git push -u origin main --force

if %errorlevel% neq 0 (
    echo.
    echo ERROR: Git push failed!
    pause
    exit /b 1
)

echo.
echo ========================================
echo SUCCESS!
echo ========================================
echo.
echo Ghost Engine code pushed to GitHub!
echo.
echo Next steps:
echo 1. Go to https://github.com/ghostdriveg1/ghost-engine
echo 2. Click Code → Codespaces → Create codespace on main
echo 3. Wait 2-3 minutes for auto-setup
echo 4. Copy the Codespace URL from Ports tab (port 3001)
echo 5. Update Engine URL in https://ghost-ui.pages.dev/settings
echo.
pause
