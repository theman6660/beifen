param(
  [string]$Reason = "verified local deploy request",
  [string]$Repo = "theman6660/beifen",
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
$RepoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))

function Invoke-Native {
  param([string]$Command, [string[]]$Arguments)
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git is not available in PATH" }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "GitHub CLI gh is not available in PATH" }

Push-Location -LiteralPath $RepoRoot
try {
  $dirty = @(git status --porcelain)
  if ($LASTEXITCODE -ne 0) { throw "Unable to read git status" }
  if ($dirty.Count -gt 0) {
    throw "Refuse to deploy from a dirty worktree. Commit and push the intended source changes first."
  }

  Invoke-Native git @("fetch", "origin", $Branch)
  $currentBranch = (git branch --show-current).Trim()
  $localHead = (git rev-parse HEAD).Trim()
  $remoteHead = (git rev-parse "origin/$Branch").Trim()
  if ($currentBranch -ne $Branch) { throw "Refuse to deploy branch '$currentBranch'; expected '$Branch'." }
  if ($localHead -ne $remoteHead) {
    throw "Refuse to deploy a stale or unpushed checkout. local=$localHead remote=$remoteHead"
  }

  Invoke-Native gh @(
    "workflow", "run", "manual-site-redeploy.yml",
    "--repo", $Repo,
    "--ref", $Branch,
    "-f", "ref=$Branch",
    "-f", "reason=$Reason"
  )
  Write-Host "Dispatched audited site redeploy for $Repo@$remoteHead"
} finally {
  Pop-Location
}
