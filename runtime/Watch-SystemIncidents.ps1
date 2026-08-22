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
$credentialFingerprintPath = [IO.Path]::GetFullPath((Join-Path $stateRoot "system-incident-github-credential.sha256"))
$failurePolicyPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "GitHubFailurePolicy.ps1"))
$githubOwner = "VincentL01"
$repository = "$githubOwner/LaAzienda"
$workerId = "omc-system-incident-watcher"
$githubApi = "https://api.github.com"

foreach ($resolvedPath in @($stateRoot, $githubTokenPath, $bridgeTokenPath, $logPath, $credentialFingerprintPath, $failurePolicyPath)) {
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
$githubCredentialFingerprint = ""
$acknowledgedGithubCredentialFingerprint = if (Test-Path -LiteralPath $credentialFingerprintPath -PathType Leaf) {
  $savedFingerprint = [IO.File]::ReadAllText($credentialFingerprintPath).Trim()
  if ($savedFingerprint -match '^[a-f0-9]{64}$') { $savedFingerprint } else { "" }
} else { "" }

function Save-AcknowledgedGitHubCredentialFingerprint([string]$Fingerprint) {
  if ($Fingerprint -notmatch '^[a-f0-9]{64}$') { throw "The validated GitHub credential fingerprint is invalid." }
  if (-not $credentialFingerprintPath.StartsWith("$stateRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
    throw "The GitHub credential acknowledgement left the ignored runtime state directory."
  }
  if ((Test-Path -LiteralPath $credentialFingerprintPath) -and
      ((Get-Item -LiteralPath $credentialFingerprintPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "The GitHub credential acknowledgement path is unsafe."
  }

  $temporaryPath = "$credentialFingerprintPath.$PID.tmp"
  $bytes = [Text.Encoding]::ASCII.GetBytes("$Fingerprint`n")
  try {
    $stream = [IO.File]::Open($temporaryPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally {
      $stream.Dispose()
    }
    if (Test-Path -LiteralPath $credentialFingerprintPath -PathType Leaf) {
      [IO.File]::Replace($temporaryPath, $credentialFingerprintPath, $null)
    } else {
      [IO.File]::Move($temporaryPath, $credentialFingerprintPath)
    }
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
    if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
  }
}

function Update-GitHubCredential {
  $token = [IO.File]::ReadAllText($githubTokenPath).Trim()
  if ($token.Length -lt 20) { throw "The ignored GitHub credential is invalid." }
  $tokenBytes = [Text.Encoding]::UTF8.GetBytes($token)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $fingerprint = [BitConverter]::ToString($hasher.ComputeHash($tokenBytes)).Replace("-", "").ToLowerInvariant()
    if ($fingerprint -eq $script:githubCredentialFingerprint) { return }
    $candidateHeaders = @{
      "Accept" = "application/vnd.github+json"
      "Authorization" = "Bearer $token"
      "User-Agent" = "LaAzienda-system-incident-watcher"
      "X-GitHub-Api-Version" = "2022-11-28"
    }
    $identity = Invoke-RestMethod -Uri "$githubApi/user" -Headers $candidateHeaders -Method Get -TimeoutSec 15
    if ([string]$identity.login -cne "VincentL01") {
      throw "The ignored GitHub credential does not belong to VincentL01."
    }
    $script:githubHeaders = $candidateHeaders
    $script:githubCredentialFingerprint = $fingerprint
    $identity = $null
  } finally {
    $hasher.Dispose()
    if ($tokenBytes) { [Array]::Clear($tokenBytes, 0, $tokenBytes.Length) }
    $token = $null
  }
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

function Test-IncidentIssue([object]$Issue, [string]$ExpectedTitle, [string]$Marker) {
  if (-not $Issue -or $Issue.pull_request `
    -or [string]$Issue.user.login -cne $githubOwner `
    -or [string]$Issue.title -cne $ExpectedTitle) {
    return $false
  }

  $lines = @(([string]$Issue.body) -split '\r?\n')
  if ($lines.Count -ne 18 `
    -or $lines[0] -cne $Marker `
    -or $lines[1] -cne "" `
    -or $lines[2] -cne "## Automated Company Portal incident" `
    -or $lines[3] -cne "" `
    -or $lines[4] -cne "A deterministic portal failure was observed while a Codex employee run was active." `
    -or $lines[5] -cne "" `
    -or $lines[6] -notmatch '^- Category: ``(?:api_5xx|worker_exception)``$' `
    -or $lines[7] -notmatch '^- Request: ``(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|UNKNOWN) /api(?:/[A-Za-z0-9_-]{1,80}){1,8}``$' `
    -or $lines[8] -notmatch '^- HTTP status: ``(?:5[0-9]{2}|not available)``$' `
    -or $lines[9] -notmatch '^- Employee record: ``employee-(?:[A-Za-z0-9._-]{1,100}|unknown)``$' `
    -or $lines[10] -notmatch '^- Run: ``(?:[A-Za-z0-9._-]{8,120}|run-unknown)``$' `
    -or $lines[11] -notmatch '^- Task: ``(?:task-[A-Za-z0-9._-]{1,100}|task-unknown|not linked)``$' `
    -or $lines[12] -notmatch '^- Portal commit: ``(?:[a-f0-9]{7,64}|not recorded)``$' `
    -or $lines[13] -notmatch '^- Occurrences before filing: ``[0-9]+``$' `
    -or $lines[14] -cne "" `
    -or $lines[15] -cne "## Diagnostic boundary" `
    -or $lines[16] -cne "" `
    -or $lines[17] -cne "The public issue contains only allowlisted operational metadata. Diagnostic text remains in the machine-local D1 run timeline for CEO review.") {
    return $false
  }
  return $true
}

function Find-ExistingIssue([string]$ExpectedTitle, [string]$Marker) {
  for ($page = 1; $page -le 20; $page++) {
    $items = @(Invoke-RestMethod -Uri "$githubApi/repos/$repository/issues?state=all&sort=created&direction=desc&per_page=100&page=$page" `
      -Headers $githubHeaders -Method Get -TimeoutSec 20)
    foreach ($item in $items) {
      if (Test-IncidentIssue $item $ExpectedTitle $Marker) { return $item }
    }
    if ($items.Count -lt 100) { break }
  }
  return $null
}

function Get-IncidentIssueDocument([object]$Incident, [string]$Marker) {
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
  return [pscustomobject]@{ title = $title; body = ($bodyLines -join "`n") }
}

function New-IncidentIssue([object]$Document, [string]$Marker) {
  $payload = @{ title = [string]$Document.title; body = [string]$Document.body } | ConvertTo-Json -Compress
  $created = Invoke-RestMethod -Uri "$githubApi/repos/$repository/issues" -Headers $githubHeaders `
    -Method Post -ContentType "application/json" -Body $payload -TimeoutSec 20
  if ([int]$created.number -lt 1 -or -not (Test-IncidentIssue $created ([string]$Document.title) $Marker)) {
    throw [IO.InvalidDataException]::new("The created GitHub issue did not match the authorized incident document.")
  }
  return $created
}

function Get-VerifiedIssue([object]$Issue, [string]$ExpectedTitle, [string]$Marker) {
  $number = [int]$Issue.number
  if ($number -lt 1) { throw [IO.InvalidDataException]::new("GitHub did not return an issue number.") }
  $verified = Invoke-RestMethod -Uri "$githubApi/repos/$repository/issues/$number" -Headers $githubHeaders -Method Get -TimeoutSec 20
  $expectedUrl = "https://github.com/$repository/issues/$number"
  $expectedRepositoryUrl = "$githubApi/repos/$repository"
  if ([string]$verified.html_url -ne $expectedUrl `
    -or [string]$verified.repository_url -ne $expectedRepositoryUrl `
    -or -not (Test-IncidentIssue $verified $ExpectedTitle $Marker)) {
    throw [IO.InvalidDataException]::new("The GitHub issue read-back did not match the authorized incident document.")
  }
  if ([string]$verified.state -eq "closed") {
    $reopenPayload = @{ state = "open" } | ConvertTo-Json -Compress
    $verified = Invoke-RestMethod -Uri "$githubApi/repos/$repository/issues/$number" -Headers $githubHeaders `
      -Method Patch -ContentType "application/json" -Body $reopenPayload -TimeoutSec 20
  }
  if ([string]$verified.html_url -ne $expectedUrl `
    -or [string]$verified.repository_url -ne $expectedRepositoryUrl `
    -or -not (Test-IncidentIssue $verified $ExpectedTitle $Marker)) {
    throw [IO.InvalidDataException]::new("The GitHub issue read-back did not match the authorized incident document.")
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
  if ($script:acknowledgedGithubCredentialFingerprint -ne $script:githubCredentialFingerprint) {
    Invoke-Control @{ action = "requeueBlocked"; workerId = $workerId } | Out-Null
    Save-AcknowledgedGitHubCredentialFingerprint $script:githubCredentialFingerprint
    $script:acknowledgedGithubCredentialFingerprint = $script:githubCredentialFingerprint
    Write-WatcherLog "A validated GitHub credential change requeued blocked incident delivery."
  }
  $claim = Invoke-Control @{
    action = "claimIncident"
    workerId = $workerId
  }
  $incident = $claim.incident
  if (-not $incident) { return $false }

  try {
    $marker = Get-IncidentMarker ([string]$incident.fingerprint)
    $document = Get-IncidentIssueDocument $incident $marker
    $issue = Find-ExistingIssue ([string]$document.title) $marker
    if (-not $issue) { $issue = New-IncidentIssue $document $marker }
    $verified = Get-VerifiedIssue $issue ([string]$document.title) $marker
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
  do {
    try { Invoke-IncidentDelivery | Out-Null } catch { Write-WatcherLog "Incident delivery check deferred." }
    if (-not $Once) { Start-Sleep -Seconds $PollSeconds }
  } while (-not $Once)
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
