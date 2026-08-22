[CmdletBinding()]
param(
  [string]$RepositoryRoot = "",
  [string]$ControlUrl = "http://127.0.0.1:3002",
  [int]$PollSeconds = 15,
  [switch]$Once
)

$ErrorActionPreference = "Stop"
if ($PollSeconds -lt 10) { throw "The system incident watcher interval must be at least ten seconds." }

$repoRoot = if ($RepositoryRoot) {
  [IO.Path]::GetFullPath($RepositoryRoot)
} else {
  [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
}
$stateRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "state"))
$githubTokenPath = [IO.Path]::GetFullPath((Join-Path $repoRoot "assets\github_auth\token"))
$bridgeTokenPath = [IO.Path]::GetFullPath((Join-Path $stateRoot "runtime-bridge-token"))
$logPath = [IO.Path]::GetFullPath((Join-Path $stateRoot "system-incident-watcher.log"))
$failurePolicyPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "GitHubFailurePolicy.ps1"))
$repository = "VincentL01/LaAzienda"
$workerId = "omc-system-incident-watcher"
$githubApi = "https://api.github.com"

foreach ($resolvedPath in @($stateRoot, $githubTokenPath, $bridgeTokenPath, $logPath, $failurePolicyPath)) {
  if (-not $resolvedPath.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Resolved system incident watcher path left the repository boundary."
  }
}
if (-not (Test-Path -LiteralPath $failurePolicyPath -PathType Leaf)) { throw "The GitHub failure policy is unavailable." }
. $failurePolicyPath
if (-not (Test-Path -LiteralPath $githubTokenPath -PathType Leaf)) { throw "The ignored GitHub credential is unavailable." }
if (-not (Test-Path -LiteralPath $bridgeTokenPath -PathType Leaf)) { throw "The runtime bridge token is unavailable." }
New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null

$bridgeToken = [IO.File]::ReadAllText($bridgeTokenPath).Trim()
if ($bridgeToken.Length -lt 32) { throw "The runtime bridge credential is invalid." }
$controlBase = $ControlUrl.TrimEnd('/')
$controlHeaders = @{ "x-runtime-bridge-token" = $bridgeToken }
$githubHeaders = @{}

function Update-GitHubCredential {
  $token = [IO.File]::ReadAllText($githubTokenPath).Trim()
  if ($token.Length -lt 20) { throw "The ignored GitHub credential is invalid." }
  $script:githubHeaders = @{
    "Accept" = "application/vnd.github+json"
    "Authorization" = "Bearer $token"
    "User-Agent" = "LaAzienda-system-incident-watcher"
    "X-GitHub-Api-Version" = "2022-11-28"
  }
  $token = $null
}

function Write-WatcherLog([string]$Message) {
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
}

function Invoke-Control([hashtable]$Payload) {
  Invoke-RestMethod -Uri "$controlBase/api/system-incidents" -Headers $controlHeaders `
    -Method Post -ContentType "application/json" -Body ($Payload | ConvertTo-Json -Compress) -TimeoutSec 15
}

function Get-IncidentMarker([string]$Fingerprint) {
  if ($Fingerprint -notmatch '^[a-f0-9]{64}$') { throw [IO.InvalidDataException]::new("Invalid incident fingerprint.") }
  return "<!-- laazienda-system-incident:v1:$Fingerprint -->"
}

function Get-PublicIdentifier([object]$Value, [string]$Pattern, [string]$Fallback) {
  $text = [string]$Value
  if ($text -match $Pattern) { return $text }
  return $Fallback
}

function Get-PublicRoute([object]$Value) {
  return Get-PublicIdentifier $Value '^/api(?:/[A-Za-z0-9_-]{1,80}){1,8}$' '/api/unknown'
}

function Find-ExistingIssue([string]$Marker) {
  for ($page = 1; $page -le 20; $page++) {
    $items = @(Invoke-RestMethod -Uri "$githubApi/repos/$repository/issues?state=all&sort=created&direction=desc&per_page=100&page=$page" `
      -Headers $githubHeaders -Method Get -TimeoutSec 20)
    foreach ($item in $items) {
      if (-not $item.pull_request -and [string]$item.body -and ([string]$item.body).Contains($Marker)) { return $item }
    }
    if ($items.Count -lt 100) { break }
  }
  return $null
}

function New-IncidentIssue([object]$Incident, [string]$Marker) {
  $shortFingerprint = ([string]$Incident.fingerprint).Substring(0, 8)
  $route = Get-PublicRoute $Incident.route
  $method = Get-PublicIdentifier $Incident.method '^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$' 'UNKNOWN'
  $category = Get-PublicIdentifier $Incident.category '^(api_5xx|worker_exception)$' 'worker_exception'
  $employeeId = Get-PublicIdentifier $Incident.employeeId '^employee-[A-Za-z0-9._-]{1,100}$' 'employee-unknown'
  $runId = Get-PublicIdentifier $Incident.runId '^[A-Za-z0-9._-]{8,120}$' 'run-unknown'
  $taskId = if ($Incident.taskId) {
    Get-PublicIdentifier $Incident.taskId '^task-[A-Za-z0-9._-]{1,100}$' 'task-unknown'
  } else { 'not linked' }
  $buildCommit = Get-PublicIdentifier $Incident.buildCommit '^[a-f0-9]{7,64}$' 'not recorded'
  $httpStatus = if ([int]$Incident.httpStatus -ge 500 -and [int]$Incident.httpStatus -le 599) {
    [string][int]$Incident.httpStatus
  } else { 'not available' }
  $title = "[Portal bug $shortFingerprint] $method $route"
  if ($title.Length -gt 220) { $title = $title.Substring(0, 220) }
  $bodyLines = @(
    $Marker,
    "",
    "## Automated Company Portal incident",
    "",
    "A deterministic portal failure was observed while a Codex employee run was active.",
    "",
    "- Category: ``$category``",
    "- Request: ``$method $route``",
    "- HTTP status: ``$httpStatus``",
    "- Employee record: ``$employeeId``",
    "- Run: ``$runId``",
    "- Task: ``$taskId``",
    "- Portal commit: ``$buildCommit``",
    "- Occurrences before filing: ``$([int]$Incident.occurrenceCount)``",
    "",
    "## Diagnostic boundary",
    "",
    "The public issue contains only allowlisted operational metadata. Diagnostic text remains in the machine-local D1 run timeline for CEO review."
  )
  $payload = @{ title = $title; body = ($bodyLines -join "`n") } | ConvertTo-Json -Compress
  return Invoke-RestMethod -Uri "$githubApi/repos/$repository/issues" -Headers $githubHeaders `
    -Method Post -ContentType "application/json" -Body $payload -TimeoutSec 20
}

function Get-VerifiedIssue([object]$Issue, [string]$Marker) {
  $number = [int]$Issue.number
  if ($number -lt 1) { throw [IO.InvalidDataException]::new("GitHub did not return an issue number.") }
  $verified = Invoke-RestMethod -Uri "$githubApi/repos/$repository/issues/$number" -Headers $githubHeaders -Method Get -TimeoutSec 20
  if ([string]$verified.state -eq "closed") {
    $reopenPayload = @{ state = "open" } | ConvertTo-Json -Compress
    $verified = Invoke-RestMethod -Uri "$githubApi/repos/$repository/issues/$number" -Headers $githubHeaders `
      -Method Patch -ContentType "application/json" -Body $reopenPayload -TimeoutSec 20
  }
  $expectedUrl = "https://github.com/$repository/issues/$number"
  $expectedRepositoryUrl = "$githubApi/repos/$repository"
  if ($verified.pull_request -or [string]$verified.html_url -ne $expectedUrl `
    -or [string]$verified.repository_url -ne $expectedRepositoryUrl `
    -or -not ([string]$verified.body).Contains($Marker)) {
    throw [IO.InvalidDataException]::new("The GitHub issue read-back did not match the incident marker.")
  }
  return $verified
}

function Get-ResponseHeaderValue([object]$Response, [string]$Name) {
  if (-not $Response) { return "" }
  try {
    $values = @($Response.Headers.GetValues($Name))
    if ($values.Count -gt 0) { return [string]$values[0] }
  } catch {}
  try { return [string]$Response.Headers[$Name] } catch { return "" }
}

function Get-FailureCode([Management.Automation.ErrorRecord]$ErrorRecord) {
  $Exception = $ErrorRecord.Exception
  $statusCode = 0
  try { $statusCode = [int]$Exception.Response.StatusCode } catch { $statusCode = 0 }
  $retryAfter = Get-ResponseHeaderValue $Exception.Response "Retry-After"
  $rateLimitRemaining = Get-ResponseHeaderValue $Exception.Response "X-RateLimit-Remaining"
  $detail = "$($Exception.Message) $($ErrorRecord.ErrorDetails.Message)"
  return Resolve-GitHubFailureCode -StatusCode $statusCode -RetryAfter $retryAfter `
    -RateLimitRemaining $rateLimitRemaining -Detail $detail `
    -VerificationFailure:($Exception -is [IO.InvalidDataException])
}

function Invoke-IncidentDelivery {
  Update-GitHubCredential
  $claim = Invoke-Control @{
    action = "claimIncident"
    workerId = $workerId
  }
  $incident = $claim.incident
  if (-not $incident) { return $false }

  try {
    $marker = Get-IncidentMarker ([string]$incident.fingerprint)
    $issue = Find-ExistingIssue $marker
    if (-not $issue) { $issue = New-IncidentIssue $incident $marker }
    $verified = Get-VerifiedIssue $issue $marker
    Invoke-Control @{
      action = "completeIncident"
      workerId = $workerId
      incidentId = [string]$incident.id
      leaseToken = [string]$incident.leaseToken
      issueNumber = [int]$verified.number
      issueUrl = [string]$verified.html_url
    } | Out-Null
    Write-WatcherLog "Filed incident $($incident.id) as issue #$($verified.number)."
  } catch {
    $failureCode = Get-FailureCode $_
    try {
      Invoke-Control @{
        action = "failIncident"
        workerId = $workerId
        incidentId = [string]$incident.id
        leaseToken = [string]$incident.leaseToken
        failureCode = $failureCode
      } | Out-Null
    } catch {
      # The lease expires safely; a later pass will recover it and search for the marker before creating anything.
    }
    Write-WatcherLog "Incident $($incident.id) delivery deferred with $failureCode."
  }
  return $true
}

$createdNew = $false
$mutex = New-Object Threading.Mutex($true, "Local\LaAziendaSystemIncidentWatcher", [ref]$createdNew)
if (-not $createdNew) {
  $mutex.Dispose()
  return
}

try {
  Write-WatcherLog "System incident watcher started."
  try {
    Invoke-Control @{ action = "requeueBlocked"; workerId = $workerId } | Out-Null
  } catch {
    Write-WatcherLog "Previously blocked incident recovery was deferred."
  }
  do {
    try { Invoke-IncidentDelivery | Out-Null } catch { Write-WatcherLog "Incident delivery check deferred." }
    if (-not $Once) { Start-Sleep -Seconds $PollSeconds }
  } while (-not $Once)
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
