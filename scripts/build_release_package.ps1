param(
    [string]$Version = "0.1.3",
    [string]$OutputDir
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not $OutputDir) {
    $OutputDir = Join-Path $RootDir "dist"
}

$PackageName = "novel-agent-demo-v$Version"
$StageDir = Join-Path $OutputDir $PackageName
$ZipPath = Join-Path $OutputDir "$PackageName.zip"

function Copy-TrackedFile {
    param([string]$RelativePath)
    $src = Join-Path $RootDir $RelativePath
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) {
        return
    }
    $dst = Join-Path $StageDir $RelativePath
    $dstDir = Split-Path -Parent $dst
    New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Force
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
if (Test-Path -LiteralPath $StageDir) {
    Remove-Item -LiteralPath $StageDir -Recurse -Force
}
if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
}
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null

$trackedBytes = & git -C $RootDir -c core.quotepath=false ls-files -z
if ($LASTEXITCODE -ne 0) {
    throw "git ls-files failed"
}
$tracked = @($trackedBytes -split "`0" | Where-Object { $_ })

$excludePrefixes = @(
    ".runtime/",
    "dev_repo/",
    ".codex/",
    ".claude/",
    ".vscode/",
    ".dify_backups/",
    "novels/",
    "novel_git_server/storage/",
    "frontend/node_modules/",
    "frontend/dist/",
    "frontend/.vite/",
    "novel_git_server/.venv/",
    "scripts/tomato_experiments/",
    "video_specs/"
)
$excludeExact = @(
    "AGENTS.md"
)

foreach ($file in $tracked) {
    $norm = $file.Replace("\", "/")
    if ($excludeExact -contains $norm) { continue }
    $skip = $false
    foreach ($prefix in $excludePrefixes) {
        if ($norm.StartsWith($prefix)) {
            $skip = $true
            break
        }
    }
    if ($skip) { continue }
    Copy-TrackedFile -RelativePath $file
}

$releaseReadmeTemplatePath = Join-Path $RootDir "docs/RELEASE_README_TEMPLATE.md"
if (Test-Path -LiteralPath $releaseReadmeTemplatePath -PathType Leaf) {
    $releaseReadme = (Get-Content -LiteralPath $releaseReadmeTemplatePath -Raw -Encoding UTF8).Replace("{{VERSION}}", $Version)
}
else {
    $releaseReadme = "# Novel Agent Demo Release v$Version`r`n`r`nRead README.md and docs/DEPLOYMENT.md for deployment details.`r`n"
}

Set-Content -LiteralPath (Join-Path $StageDir "RELEASE_README.md") -Value $releaseReadme -Encoding UTF8

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    $stageFullPath = (Resolve-Path -LiteralPath $StageDir).Path.TrimEnd("\", "/")
    $stagePrefixLength = $stageFullPath.Length + 1
    Get-ChildItem -LiteralPath $StageDir -Recurse -File | ForEach-Object {
        $relativePath = $_.FullName.Substring($stagePrefixLength)
        $entryName = $relativePath.Replace("\", "/")
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
}
finally {
    $zip.Dispose()
}
if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) {
    throw "release zip was not created: $ZipPath"
}

$requiredEntries = @(
    "README.md",
    "RELEASE_README.md",
    "docs/DEPLOYMENT.md",
    "deploy/demo/.env.example",
    "deploy/public_demo/README.md",
    "deploy/public_demo/.env.example",
    "deploy/public_demo/static_proxy.py",
    "docker-compose.demo.yml",
    "docker-compose.ghcr.yml",
    "start_demo.ps1",
    "dify_workflows/README.md"
)
$forbiddenPrefixes = @(
    ".runtime/",
    "dev_repo/",
    ".codex/",
    ".claude/",
    ".dify_backups/",
    "novels/",
    "novel_git_server/storage/",
    "frontend/node_modules/",
    "frontend/dist/",
    "novel_git_server/.venv/",
    "scripts/tomato_experiments/",
    "video_specs/",
    "dist/"
)
$forbiddenExact = @(
    "AGENTS.md",
    "deploy/demo/.env"
)

$verifyZip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
try {
    $entries = @($verifyZip.Entries | ForEach-Object { $_.FullName })
    foreach ($entry in $requiredEntries) {
        if ($entries -notcontains $entry) {
            throw "release zip missing required entry: $entry"
        }
    }
    foreach ($entry in $entries) {
        if ($forbiddenExact -contains $entry) {
            throw "release zip contains forbidden entry: $entry"
        }
        foreach ($prefix in $forbiddenPrefixes) {
            if ($entry.StartsWith($prefix)) {
                throw "release zip contains forbidden path: $entry"
            }
        }
    }
}
finally {
    $verifyZip.Dispose()
}
Write-Output $ZipPath
