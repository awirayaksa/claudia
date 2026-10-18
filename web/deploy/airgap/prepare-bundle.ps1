<#
.SYNOPSIS
  Builds an offline bundle of Claudia Web for an air-gapped Ubuntu 24.04 host.

.DESCRIPTION
  Run on a Windows machine with internet access, Git and Docker Desktop
  (Linux containers), or on Linux with PowerShell 7 (pwsh), Git and Docker,
  as the release workflow does. The bundle holds everything the target needs:

    images\     claudia-web (built from the release) and pgvector/pgvector
    debs\       Docker Engine and the compose plugin for Ubuntu 24.04 (noble),
                with the dependencies a fresh install lacks
    install.sh, compose.yml, compose.sandbox.yml, README.md
    bundle.env  what was built (version, commit, image names)
    SHA256SUMS

  and is packed as claudia-web-<version>-airgap-<arch>.tar, next to a
  .tar.sha256 to check the copy on the target.

  The image is built from a clean export of the chosen commit: uncommitted
  changes in this checkout are not included.

.PARAMETER Ref
  Tag, branch or commit to build. Default: the newest v* release tag that
  contains Claudia Web (web/docker/Dockerfile). A branch is built as it is
  on origin (after fetching), not as your local copy of it.

.PARAMETER Arch
  CPU architecture of the target host: amd64 (default) or arm64.

.PARAMETER OutDir
  Where the bundle folder and .tar are written. Default: out\ next to this script.

.PARAMETER PgvectorImage
  PostgreSQL + pgvector image. Default: pgvector/pgvector:pg16.

.PARAMETER SkipDockerPackages
  Leave out the Docker Engine packages (the target already has Docker and
  the compose plugin).

.PARAMETER NoFetch
  Don't fetch tags and branches from origin first.

.PARAMETER NoArchive
  Leave the bundle as a folder; don't pack it into a .tar.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File web\deploy\airgap\prepare-bundle.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File web\deploy\airgap\prepare-bundle.ps1 -Ref main
#>
[CmdletBinding()]
param(
  [string]$Ref,
  [ValidateSet('amd64', 'arm64')]
  [string]$Arch = 'amd64',
  [string]$OutDir,
  [string]$PgvectorImage = 'pgvector/pgvector:pg16',
  [switch]$SkipDockerPackages,
  [switch]$NoFetch,
  [switch]$NoArchive
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
}

# Runs a native command and stops on a non-zero exit code. Windows PowerShell
# can turn a native program's stderr into errors under 'Stop', and git and
# docker report progress there, so it is relaxed for the call.
function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$What,
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )
  $ErrorActionPreference = 'Continue'
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)." }
}

# True when the native command exits with 0; its output is discarded.
function Test-Native([scriptblock]$Command) {
  $ErrorActionPreference = 'Continue'
  & $Command *> $null
  return ($LASTEXITCODE -eq 0)
}

# Copies a text file with LF line endings and no BOM, whatever the checkout
# did to it: bash on the target chokes on CRLF.
function Copy-Lf([string]$From, [string]$To) {
  $text = [IO.File]::ReadAllText($From) -replace "`r`n", "`n"
  [IO.File]::WriteAllText($To, $text, (New-Object System.Text.UTF8Encoding $false))
}

function Write-Lf([string]$Path, [string[]]$Lines) {
  [IO.File]::WriteAllText($Path, (($Lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding $false))
}

$onWindows = $env:OS -eq 'Windows_NT'
if ($onWindows) {
  # Windows' own bsdtar; Git for Windows may put another tar first on PATH
  $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path $tarExe)) { throw "tar.exe not found at $tarExe (Windows 10 1803 or later is needed)." }
} else {
  $tarExe = 'tar'
}

# Windows PowerShell leaves $PSScriptRoot empty in parameter defaults
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'out' }
$OutDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutDir)
$platform = "linux/$Arch"

# --- Prerequisites ------------------------------------------------------------

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is not on PATH.' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker is not on PATH. Install Docker Desktop.' }
if (-not (Test-Native { docker info })) { throw 'Docker is not running. Start Docker Desktop and try again.' }
$osType = Invoke-Native 'Checking Docker' { docker info --format '{{.OSType}}' }
if ($osType -ne 'linux') { throw 'Docker Desktop is in Windows containers mode. Switch to Linux containers and try again.' }

$repo = Invoke-Native 'Finding the repository' { git -C $PSScriptRoot rev-parse --show-toplevel }

# --- What to build ------------------------------------------------------------

if (-not $NoFetch) {
  Write-Step 'Fetching tags and branches from origin'
  if (-not (Test-Native { git -C $repo fetch --tags --quiet origin })) {
    Write-Warning 'Could not fetch from origin; using the tags already in this checkout.'
  }
}

if (-not $Ref) {
  $tags = @(git -C $repo tag --list 'v*' --sort=-v:refname)
  foreach ($t in $tags) {
    if (Test-Native { git -C $repo cat-file -e "$($t):web/docker/Dockerfile" }) { $Ref = $t; break }
  }
  if (-not $Ref) {
    $newest = 'none'
    if ($tags.Count -gt 0) { $newest = $tags[0] }
    throw ("No release tag contains Claudia Web yet (newest tag: $newest). Tag a release that " +
      'includes web/, or choose what to build with -Ref, e.g. -Ref main.')
  }
}

# A branch name means the branch on origin: fetching updates origin/<branch>
# but never the local branch, which may be far behind (or never pushed)
$resolve = $Ref
if (Test-Native { git -C $repo show-ref --verify --quiet "refs/remotes/origin/$Ref" }) {
  $resolve = "refs/remotes/origin/$Ref"
  if (Test-Native { git -C $repo show-ref --verify --quiet "refs/heads/$Ref" }) {
    $localSha = git -C $repo rev-parse "refs/heads/$Ref"
    $remoteSha = git -C $repo rev-parse $resolve
    if ($localSha -ne $remoteSha) {
      $ahead = git -C $repo rev-list --count "$($remoteSha)..$($localSha)"
      $note = ''
      if ([int]$ahead -gt 0) { $note = " Your local '$Ref' has $ahead commit(s) not on origin: push them, or pass -Ref $($localSha.Substring(0, 12)) to build it as it is here." }
      Write-Warning "Building origin/$Ref ($($remoteSha.Substring(0, 12))), not your local '$Ref' ($($localSha.Substring(0, 12))).$note"
    }
  }
}

$sha = [string](Invoke-Native "Resolving '$Ref'" { git -C $repo rev-parse --verify --quiet "$resolve^{commit}" })
if (-not (Test-Native { git -C $repo cat-file -e "$($sha):web/docker/Dockerfile" })) {
  throw "'$Ref' does not contain Claudia Web (no web/docker/Dockerfile)."
}

$releaseTag = git -C $repo tag --points-at $sha --list 'v*' --sort=-v:refname | Select-Object -First 1
if ($releaseTag) {
  $version = $releaseTag -replace '^v', ''
} elseif ($sha.StartsWith($Ref)) {
  $version = $sha.Substring(0, 12)
} else {
  $version = (($Ref -replace '[^A-Za-z0-9_.-]', '-') -replace '^[.-]+', '') + '-' + $sha.Substring(0, 7)
}

$dirty = git -C $repo status --porcelain -- web src electron/services tailwind.config.js
if ($dirty -and -not $releaseTag) {
  Write-Warning 'This checkout has uncommitted changes under web/ or the shared code; they are not part of the bundle (it is built from the commit).'
}

$image = "claudia-web:$version"
$name = "claudia-web-$version-airgap-$Arch"
$bundle = Join-Path $OutDir $name
$work = Join-Path ([IO.Path]::GetTempPath()) "claudia-airgap-$($sha.Substring(0, 12))"

Write-Host ''
Write-Host "  Building   $Ref ($($sha.Substring(0, 12)))"
Write-Host "  Image      $image ($platform)"
Write-Host "  Database   $PgvectorImage"
Write-Host "  Bundle     $bundle"
Write-Host ''

try {
  foreach ($dir in @($bundle, $work)) {
    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
  }
  $src = Join-Path $work 'src'
  $tools = Join-Path $work 'tools'
  $imagesDir = Join-Path $bundle 'images'
  $debDir = Join-Path $bundle 'debs'
  New-Item -ItemType Directory -Force $src, $tools, $imagesDir | Out-Null

  # --- Image ------------------------------------------------------------------

  Write-Step 'Exporting the source of the commit'
  # Only what the Dockerfile copies; autocrlf off keeps the files as committed (LF)
  $srcTar = Join-Path $work 'src.tar'
  Invoke-Native 'git archive' {
    git -C $repo -c core.autocrlf=false archive --format=tar -o $srcTar $sha src electron/services tailwind.config.js web
  }
  Invoke-Native 'Extracting the source' { & $tarExe -xf $srcTar -C $src }

  Write-Step "Building $image"
  Invoke-Native 'docker build' {
    docker build --platform $platform --load `
      -f ([IO.Path]::Combine($src, 'web', 'docker', 'Dockerfile')) `
      -t $image `
      --label "org.opencontainers.image.version=$version" `
      --label "org.opencontainers.image.revision=$sha" `
      $src
  }

  Write-Step "Pulling $PgvectorImage"
  Invoke-Native 'docker pull' { docker pull --platform $platform $PgvectorImage }

  foreach ($pair in @(@($image, 'claudia-web.tar'), @($PgvectorImage, 'pgvector.tar'))) {
    $img = $pair[0]
    $file = Join-Path $imagesDir $pair[1]
    Write-Step "Saving $img"
    # --platform keeps a multi-platform image to the one the target runs;
    # older Docker versions don't know the flag
    if (-not (Test-Native { docker save --platform $platform -o $file $img })) {
      Invoke-Native "Saving $img" { docker save -o $file $img }
    }
  }

  # --- Docker Engine packages -------------------------------------------------

  if (-not $SkipDockerPackages) {
    Write-Step 'Downloading Docker Engine packages for Ubuntu 24.04'
    New-Item -ItemType Directory -Force $debDir | Out-Null
    # apt in a clean ubuntu:24.04 works out the dependencies; a server
    # install has more packages than this image, so the set is enough there
    Write-Lf (Join-Path $tools 'fetch-debs.sh') @(
      'set -eu',
      'export DEBIAN_FRONTEND=noninteractive',
      'apt-get update -q',
      'apt-get install -y -q --no-install-recommends ca-certificates curl > /dev/null',
      'install -m 0755 -d /etc/apt/keyrings',
      'curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc',
      'echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list',
      'apt-get update -q',
      'apt-get clean',
      'apt-get install -y -q --download-only --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
      'cp /var/cache/apt/archives/*.deb /out/',
      '# On Linux the files would otherwise belong to root',
      'if [ -n "${OWNER:-}" ]; then chown -R "$OWNER" /out; fi',
      'ls /out'
    )
    $owner = ''
    if (-not $onWindows) { $owner = "$(id -u):$(id -g)" }
    Invoke-Native 'Downloading the packages' {
      docker run --rm --platform $platform -e "ARCH=$Arch" -e "OWNER=$owner" `
        -v "$($tools):/tools:ro" -v "$($debDir):/out" `
        ubuntu:24.04 bash /tools/fetch-debs.sh
    }
  }

  # --- Installer, manifest, checksums -----------------------------------------

  Write-Step 'Writing the installer and checksums'
  foreach ($f in @('install.sh', 'compose.yml', 'compose.sandbox.yml', 'README.md')) {
    Copy-Lf (Join-Path $PSScriptRoot $f) (Join-Path $bundle $f)
  }
  Write-Lf (Join-Path $bundle 'bundle.env') @(
    '# What this bundle holds (written by prepare-bundle.ps1)',
    "CLAUDIA_VERSION='$version'",
    "CLAUDIA_REVISION='$sha'",
    "CLAUDIA_IMAGE='$image'",
    "PGVECTOR_IMAGE='$PgvectorImage'",
    "BUNDLE_ARCH='$Arch'",
    "BUNDLE_CREATED='$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))'"
  )

  $sums = Get-ChildItem -Recurse -File $bundle | Sort-Object FullName | ForEach-Object {
    $rel = $_.FullName.Substring($bundle.Length + 1) -replace '\\', '/'
    '{0}  {1}' -f (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower(), $rel
  }
  Write-Lf (Join-Path $bundle 'SHA256SUMS') $sums

  if (-not $NoArchive) {
    Write-Step "Packing $name.tar"
    $archive = Join-Path $OutDir "$name.tar"
    if (Test-Path $archive) { Remove-Item -Force $archive }
    Invoke-Native 'tar' { & $tarExe -cf $archive -C $OutDir $name }
    $hash = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLower()
    Write-Lf "$archive.sha256" @("$hash  $name.tar")
  }
} finally {
  if (Test-Path $work) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
}

# --- Done ---------------------------------------------------------------------

Write-Host ''
Write-Host "Bundle ready: Claudia Web $version ($Arch)" -ForegroundColor Green
if (-not $NoArchive) {
  $sizeGb = [math]::Round((Get-Item $archive).Length / 1GB, 2)
  Write-Host "  $archive ($sizeGb GB)"
  Write-Host "  $archive.sha256"
  Write-Host ''
  Write-Host 'Copy both files to the target, then:'
  Write-Host "  sha256sum -c $name.tar.sha256"
  Write-Host "  tar -xf $name.tar && cd $name"
} else {
  Write-Host "  $bundle"
  Write-Host ''
  Write-Host "Copy the $name folder to the target, then from inside it:"
}
Write-Host '  sudo bash install.sh --public-url http://<host name users open>:8080'
