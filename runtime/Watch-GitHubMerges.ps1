[CmdletBinding()]
param(
  [string]$RepositoryRoot = "",
  [string]$ControlUrl = "http://127.0.0.1:3002",
  [int]$PollSeconds = 30,
  [switch]$Once,
  [switch]$SkipCompanyRefresh
)

$ErrorActionPreference = "Stop"
if ($PollSeconds -lt 10) { throw "The GitHub merge watcher interval must be at least ten seconds." }

$repoRoot = if ($RepositoryRoot) {
  [IO.Path]::GetFullPath($RepositoryRoot)
} else {
  [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
}
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "runtime"))
$stateRoot = [IO.Path]::GetFullPath((Join-Path $runtimeRoot "state"))
$logPath = [IO.Path]::GetFullPath((Join-Path $stateRoot "github-merge-watcher.log"))
$githubTokenPath = [IO.Path]::GetFullPath((Join-Path $repoRoot "assets\github_auth\token"))
$bridgeTokenPath = [IO.Path]::GetFullPath((Join-Path $stateRoot "runtime-bridge-token"))
$startCompanyPath = [IO.Path]::GetFullPath((Join-Path $runtimeRoot "Start-Company.ps1"))
$expectedRemote = "https://github.com/VincentL01/LaAzienda.git"
$repository = "VincentL01/LaAzienda"
$owner = "VincentL01"

foreach ($resolvedPath in @($runtimeRoot, $stateRoot, $logPath, $githubTokenPath, $bridgeTokenPath, $startCompanyPath)) {
  if (-not $resolvedPath.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Resolved merge watcher path left the repository boundary."
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot ".git"))) { throw "The merge watcher requires the LaAzienda Git checkout." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Git is required by the merge watcher." }

New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
$env:GIT_TERMINAL_PROMPT = "0"
$env:GCM_INTERACTIVE = "Never"

function Write-WatcherLog([string]$Message) {
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
}

function Invoke-Git([string[]]$Arguments, [switch]$AllowFailure) {
  $output = @(& git -C $repoRoot @Arguments 2>&1)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0 -and -not $AllowFailure) {
    throw "Git operation '$($Arguments[0])' failed."
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Output = ($output -join "`n").Trim() }
}

function Get-GitHubHeaders {
  $headers = @{
    "Accept" = "application/vnd.github+json"
    "User-Agent" = "LaAzienda-merge-watcher"
    "X-GitHub-Api-Version" = "2022-11-28"
  }
  if (Test-Path -LiteralPath $githubTokenPath -PathType Leaf) {
    $token = [IO.File]::ReadAllText($githubTokenPath).Trim()
    if ($token.Length -ge 20) { $headers["Authorization"] = "Bearer $token" }
  }
  return $headers
}

function Get-VerifiedPull([object[]]$Candidates, [string]$ExpectedHeadSha = "", [string]$ExpectedHeadBranch = "") {
  $headers = Get-GitHubHeaders
  foreach ($candidate in @($Candidates | Sort-Object -Property updated_at -Descending)) {
    if (-not $candidate.number) { continue }
    $detail = Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/pulls/$($candidate.number)" -Headers $headers -Method Get -TimeoutSec 15
    if (-not $detail.merged -or $detail.merged_by.login -ne $owner -or $detail.base.ref -ne "main") { continue }
    if ($ExpectedHeadBranch -and $detail.head.ref -ne $ExpectedHeadBranch) { continue }
    if ($ExpectedHeadSha -and $detail.head.sha -ne $ExpectedHeadSha) { continue }
    return $detail
  }
  return $null
}

function Get-MergedPullForBranch([string]$Branch, [string]$HeadSha) {
  if ($Branch -notmatch '^codex/[A-Za-z0-9._/-]{1,100}$') { return $null }
  $headers = Get-GitHubHeaders
  $headLabel = [Uri]::EscapeDataString("$owner`:$Branch")
  $candidates = Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/pulls?state=closed&base=main&head=$headLabel&per_page=10" -Headers $headers -Method Get -TimeoutSec 15
  return Get-VerifiedPull -Candidates @($candidates) -ExpectedHeadSha $HeadSha -ExpectedHeadBranch $Branch
}

function Get-MergedPullForCommit([string]$CommitSha) {
  $headers = Get-GitHubHeaders
  $candidates = Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/commits/$CommitSha/pulls" -Headers $headers -Method Get -TimeoutSec 15
  return Get-VerifiedPull -Candidates @($candidates)
}

function Report-RepositorySync([object]$Pull, [string]$CommitSha) {
  if (-not (Test-Path -LiteralPath $bridgeTokenPath -PathType Leaf)) { throw "The runtime bridge token is unavailable." }
  $bridgeToken = [IO.File]::ReadAllText($bridgeTokenPath).Trim()
  $payload = @{
    action = "reportRepositorySync"
    repository = $repository
    branch = "main"
    sourceBranch = [string]$Pull.head.ref
    commitSha = $CommitSha
    pullNumber = [int]$Pull.number
  } | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri "$($ControlUrl.TrimEnd('/'))/api/company" -Headers @{ "x-runtime-bridge-token" = $bridgeToken } `
    -Method Post -ContentType "application/json" -Body $payload -TimeoutSec 15 | Out-Null
}

function Invoke-MergeSync {
  $remoteUrl = (Invoke-Git -Arguments @("remote", "get-url", "origin")).Output
  if ($remoteUrl -ne $expectedRemote) { throw "The merge watcher refuses an unexpected origin remote." }

  $dirty = (Invoke-Git -Arguments @("status", "--porcelain=v1")).Output
  if ($dirty) { return $false }

  Invoke-Git -Arguments @("fetch", "--quiet", "origin", "main") | Out-Null
  $branch = (Invoke-Git -Arguments @("branch", "--show-current")).Output
  $currentHead = (Invoke-Git -Arguments @("rev-parse", "HEAD")).Output.ToLowerInvariant()
  $remoteHead = (Invoke-Git -Arguments @("rev-parse", "refs/remotes/origin/main")).Output.ToLowerInvariant()

  if ($branch -eq "main" -and $currentHead -eq $remoteHead) { return $false }

  $pull = if ($branch -eq "main") {
    $ancestry = Invoke-Git -Arguments @("merge-base", "--is-ancestor", "main", "refs/remotes/origin/main") -AllowFailure
    if ($ancestry.ExitCode -ne 0) { return $false }
    Get-MergedPullForCommit -CommitSha $remoteHead
  } else {
    Get-MergedPullForBranch -Branch $branch -HeadSha $currentHead
  }
  if (-not $pull) { return $false }

  $dirtyAfterCheck = (Invoke-Git -Arguments @("status", "--porcelain=v1")).Output
  if ($dirtyAfterCheck) { return $false }
  if ($branch -ne "main") { Invoke-Git -Arguments @("switch", "main") | Out-Null }
  Invoke-Git -Arguments @("pull", "--ff-only", "origin", "main") | Out-Null
  $syncedHead = (Invoke-Git -Arguments @("rev-parse", "HEAD")).Output.ToLowerInvariant()
  if ($syncedHead -ne $remoteHead) { throw "The local main branch did not reach the verified remote commit." }

  if (-not $SkipCompanyRefresh) {
    & $startCompanyPath -BuildImages -SkipMergeWatcher
    if ($LASTEXITCODE -ne 0) { throw "The company could not restart after synchronizing main." }
    Report-RepositorySync -Pull $pull -CommitSha $syncedHead
  }
  Write-WatcherLog "Synchronized PR #$($pull.number) from $($pull.head.ref) to main at $($syncedHead.Substring(0, 7))."
  return $true
}

$createdNew = $false
$mutex = New-Object Threading.Mutex($true, "Local\LaAziendaGitMergeWatcher", [ref]$createdNew)
if (-not $createdNew) {
  $mutex.Dispose()
  return
}

try {
  Write-WatcherLog "GitHub merge watcher started."
  do {
    try { Invoke-MergeSync | Out-Null } catch { Write-WatcherLog "Synchronization check deferred: $($_.Exception.Message)" }
    if (-not $Once) { Start-Sleep -Seconds $PollSeconds }
  } while (-not $Once)
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
