param(
  [string]$Repo = "theman6660/beifen",
  [string]$SourceWorkflow = "daily-report.yml",
  [string]$RedeployWorkflow = "manual-site-redeploy.yml",
  [string]$Branch = "main",
  [string]$LiveSiteUrl = "https://hanxiaofan.site",
  [int]$StartHour = 9,
  [int]$EndHour = 21,
  [switch]$DryRun,
  [string]$LogPath = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $LogPath) { $LogPath = Join-Path $RepoRoot ".local-artifacts\logs\daily-report-sentinel.log" }
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
  if ($LASTEXITCODE -ne 0) {
    throw "gh $($Arguments -join ' ') failed with exit code ${LASTEXITCODE}: $output"
  }
  return $output
}

function Test-RemoteFile {
  param([string]$Path)
  $oldError = $ErrorActionPreference
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
    $ErrorActionPreference = $oldError
    if ($hasNativePreference) { $PSNativeCommandUseErrorActionPreference = $oldNativePreference }
  }
  return $exitCode -eq 0
}

function Test-LiveUrl {
  param([string]$Url)
  & curl.exe -fsSL --max-time 15 -o NUL $Url 2>$null
  return $LASTEXITCODE -eq 0
}

function Get-RunCount {
  param([string]$Workflow, [string]$Status)
  $json = Invoke-Gh @("run", "list", "--repo", $Repo, "--workflow", $Workflow, "--branch", $Branch, "--status", $Status, "--limit", "20", "--json", "databaseId")
  if (-not $json) { return 0 }
  return @(($json | ConvertFrom-Json)).Count
}

try {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "GitHub CLI gh is not available in PATH" }
  if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { throw "curl.exe is not available in PATH" }
  if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = "http://127.0.0.1:7892" }
  if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = "http://127.0.0.1:7892" }

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
  $workflow = $SourceWorkflow
  $action = "generate"
  $reason = "source posts incomplete: ai=$hasAi society=$hasSociety"

  if ($hasAi -and $hasSociety) {
    $sourceSha = (Invoke-Gh @("api", "repos/$Repo/commits/$Branch", "--jq", ".sha")).Trim()
    $markerUrl = "$($LiveSiteUrl.TrimEnd('/'))/daily-report-status.json?sentinel=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
    $markerRaw = & curl.exe -fsSL --max-time 15 $markerUrl 2>$null
    $markerOk = $false
    if ($LASTEXITCODE -eq 0 -and $markerRaw) {
      try {
        $marker = ($markerRaw -join "`n") | ConvertFrom-Json
        $markerOk = $marker.date -eq $date -and $marker.sourceCommit -eq $sourceSha
      } catch { $markerOk = $false }
    }

    $year, $month, $day = $date.Split('-')
    $site = $LiveSiteUrl.TrimEnd('/')
    $aiLive = Test-LiveUrl "$site/$year/$month/$day/ai-daily-$date/"
    $societyLive = Test-LiveUrl "$site/$year/$month/$day/society-daily-$date/"
    if ($markerOk -and $aiLive -and $societyLive) {
      Write-Log "OK: source and live deployment are current for $date at $sourceSha."
      exit 0
    }

    $workflow = $RedeployWorkflow
    $action = "redeploy"
    $reason = "live deployment stale: marker=$markerOk ai=$aiLive society=$societyLive source=$sourceSha"
  }

  $active = (Get-RunCount $workflow "queued") + (Get-RunCount $workflow "in_progress")
  if ($action -eq "redeploy") {
    $active += (Get-RunCount $SourceWorkflow "queued") + (Get-RunCount $SourceWorkflow "in_progress")
  }
  Write-Log "Recovery needed for $date. action=$action workflow=$workflow active_runs=$active reason=$reason"
  if ($active -gt 0) {
    Write-Log "Skip dispatch: recovery is already queued or in progress."
    exit 0
  }
  if ($DryRun) {
    Write-Log "Dry run: would dispatch $workflow on $Repo@$Branch."
    exit 0
  }

  if ($action -eq "generate") {
    Invoke-Gh @("workflow", "run", $SourceWorkflow, "--repo", $Repo, "--ref", $Branch) | Out-Null
  } else {
    Invoke-Gh @("workflow", "run", $RedeployWorkflow, "--repo", $Repo, "--ref", $Branch, "-f", "ref=$Branch", "-f", "reason=local sentinel: $reason") | Out-Null
  }
  Write-Log "Dispatched $workflow for $date."
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  exit 1
}
