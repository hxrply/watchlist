<#
    Publishes this folder to GitHub Pages.

    First run: creates the public repo, pushes, and turns Pages on.
    Later runs: just pushes. Safe to run repeatedly.

    Usage:  right-click -> "Run with PowerShell", or:  .\publish.ps1
            .\publish.ps1 -Name some-other-name    (defaults to the folder name)
#>
param(
    [string]$Name,
    [string]$Owner = 'hxrply'
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not $Name) { $Name = Split-Path -Leaf $PSScriptRoot }

# gh is not on PATH on this machine, so fall back to the standard install location.
$ghCmd = Get-Command gh -ErrorAction SilentlyContinue
if ($ghCmd) { $gh = $ghCmd.Source } else { $gh = "C:\Program Files\GitHub CLI\gh.exe" }
if (-not (Test-Path -LiteralPath $gh)) {
    throw "GitHub CLI not found. Install it from https://cli.github.com/ then run this again."
}

& $gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "GitHub CLI is not signed in. Run: & '$gh' auth login"
}

# ── Make sure there is something to publish ──────────────────────────────────
git rev-parse --is-inside-work-tree 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Creating a git repository here..." -ForegroundColor Cyan
    git init -b main | Out-Null
}

git rev-parse HEAD 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "No commits yet. Commit your work first, then run this again."
}

# Uncommitted work is never committed for you — that should stay your decision.
$dirty = git status --porcelain
if ($dirty) {
    Write-Host "You have uncommitted changes:" -ForegroundColor Yellow
    Write-Host $dirty
    Write-Host "Commit them first if you want them published. Pushing what's committed." -ForegroundColor Yellow
}

$branch = (git rev-parse --abbrev-ref HEAD).Trim()

# ── Create the repo, or push to the existing one ─────────────────────────────
$hasOrigin = $false
git remote get-url origin 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { $hasOrigin = $true }

if (-not $hasOrigin) {
    Write-Host "Creating public repo $Owner/$Name and pushing..." -ForegroundColor Cyan
    & $gh repo create "$Owner/$Name" --public --source=. --remote=origin --push
    if ($LASTEXITCODE -ne 0) { throw "Could not create the repository." }
} else {
    Write-Host "Pushing to existing remote..." -ForegroundColor Cyan
    git push -u origin $branch
    if ($LASTEXITCODE -ne 0) { throw "Push failed." }
}

# ── Turn on Pages (harmless to repeat — already-enabled just reports back) ───
Write-Host "Enabling GitHub Pages..." -ForegroundColor Cyan
# The body goes via a temp file, not a pipe: piping a string to a native exe in
# Windows PowerShell re-encodes it and GitHub rejects the result as bad JSON.
$body = '{"source":{"branch":"' + $branch + '","path":"/"}}'
$bodyFile = Join-Path $env:TEMP "gh-pages-body-$PID.json"
[System.IO.File]::WriteAllText($bodyFile, $body, (New-Object System.Text.UTF8Encoding($false)))
$pagesOut = & $gh api --method POST "repos/$Owner/$Name/pages" --input $bodyFile 2>&1
Remove-Item $bodyFile -Force -ErrorAction SilentlyContinue
if ($LASTEXITCODE -ne 0) {
    if ("$pagesOut" -match 'already enabled|409') {
        Write-Host "Pages was already enabled." -ForegroundColor DarkGray
    } else {
        Write-Host "Couldn't enable Pages automatically:" -ForegroundColor Yellow
        Write-Host "$pagesOut" -ForegroundColor DarkGray
        Write-Host "Turn it on under Settings -> Pages (branch $branch, /root)." -ForegroundColor Yellow
    }
}

$url = "https://$Owner.github.io/$Name/"
Write-Host ""
Write-Host "Done. Live in a minute or two at:" -ForegroundColor Green
Write-Host "  $url" -ForegroundColor Green
Write-Host "Repo: https://github.com/$Owner/$Name"
Write-Host ""
Read-Host "Press Enter to close"
