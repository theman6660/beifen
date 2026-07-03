param(
  [string]$Repo = "theman6660/beifen",
  [string]$Workflow = "daily-report.yml",
  [string]$Branch = "main",
  [int]$StartHour = 9,
  [int]$EndHour = 21,
  [switch]$DryRun,
  [string]$LogPath = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $LogPath) {
  $LogPath = Join-Path $RepoRoot ".local-artifacts\logs\daily-report-sentinel.log"
}

$LogDir = Split-Path -Parent $LogPath
if ($LogDir -and -not (Test-Path -LiteralPath $LogDir)) {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

function Write-Log {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -LiteralPath $LogPath -Value $line
  Write-Host $line
}

function Invoke-Gh {
  param([string[]]$Arguments)
  $output = & gh @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "gh $($Arguments -join ' ') failed with exit code ${exitCode}: $output"
  }
  return $output
}

function Test-RemoteFile {
  param([string]$Path)
  $oldErrorActionPreference = $ErrorActionPreference
  $hasNativePreference = Test-Path Variable:PSNativeCommandUseErrorActionPreference
  if ($hasNativePreference) {
    $oldNativePreference = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
  }

  try {
    $ErrorActionPreference = "Continue"
    & gh api "repos/$Repo/contents/$Path" --method GET -f "ref=$Branch" --jq ".sha" *> $null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldErrorActionPreference
    if ($hasNativePreference) {
      $PSNativeCommandUseErrorActionPreference = $oldNativePreference
    }
  }

  return $exitCode -eq 0
}

function Get-RunCount {
  param([string]$Status)
  $json = Invoke-Gh @("run", "list", "--repo", $Repo, "--workflow", $Workflow, "--branch", $Branch, "--status", $Status, "--limit", "20", "--json", "databaseId")
  if (-not $json) {
    return 0
  }
  $items = $json | ConvertFrom-Json
  return @($items).Count
}

try {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI gh is not available in PATH"
  }

  if (-not $env:HTTP_PROXY) {
    $env:HTTP_PROXY = "http://127.0.0.1:7892"
  }
  if (-not $env:HTTPS_PROXY) {
    $env:HTTPS_PROXY = "http://127.0.0.1:7892"
  }

  $beijingNow = (Get-Date).ToUniversalTime().AddHours(8)
  $date = $beijingNow.ToString("yyyy-MM-dd")

  if ($beijingNow.Hour -lt $StartHour -or $beijingNow.Hour -ge $EndHour) {
    Write-Log "Skip: Beijing time $($beijingNow.ToString('HH:mm')) is outside $StartHour:00-$EndHour:00."
    exit 0
  }

  $aiPath = "source/_posts/ai-daily-$date.md"
  $societyPath = "source/_posts/society-daily-$date.md"
  $hasAi = Test-RemoteFile $aiPath
  $hasSociety = Test-RemoteFile $societyPath

  if ($hasAi -and $hasSociety) {
    Write-Log "OK: today's posts already exist on $Repo@$Branch for $date."
    exit 0
  }

  $queued = Get-RunCount "queued"
  $inProgress = Get-RunCount "in_progress"
  $active = $queued + $inProgress

  Write-Log "Missing posts for $date. ai=$hasAi society=$hasSociety active_runs=$active."

  if ($active -gt 0) {
    Write-Log "Skip dispatch: a $Workflow run is already queued or in progress."
    exit 0
  }

  if ($DryRun) {
    Write-Log "Dry run: would dispatch $Workflow on $Repo@$Branch."
    exit 0
  }

  Invoke-Gh @("workflow", "run", $Workflow, "--repo", $Repo, "--ref", $Branch) | Out-Null
  Write-Log "Dispatched $Workflow for $date."
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  exit 1
}
