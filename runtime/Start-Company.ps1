[CmdletBinding()]
param(
  [switch]$BuildImages,
  [switch]$SkipMergeWatcher,
  [switch]$SkipIncidentWatcher,
  [switch]$SkipDiscord
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$pathSafetyPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "Path-Safety.ps1"))
if (-not (Test-Path -LiteralPath $pathSafetyPath -PathType Leaf)) {
  throw "The repository path-safety helper is unavailable."
}
$pathSafetyItem = Get-Item -LiteralPath $pathSafetyPath -Force
if (($pathSafetyItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "Refusing a reparse point for the repository path-safety helper."
}
. $pathSafetyPath
$stateRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "state"))
$bridgeTokenPath = [IO.Path]::GetFullPath((Join-Path $stateRoot "runtime-bridge-token"))
$assetsRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "assets"))
$ownerRoot = [IO.Path]::GetFullPath((Join-Path $assetsRoot "owner"))
$ownerRuntimeRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "assets\owner\runtime"))
$ownerCredentialPath = [IO.Path]::GetFullPath((Join-Path $ownerRuntimeRoot "credential"))
$mergeWatcherPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "Watch-GitHubMerges.ps1"))
$incidentWatcherPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "Watch-SystemIncidents.ps1"))
$discordStartPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "discord\Start-Discord.ps1"))
$githubTokenPath = [IO.Path]::GetFullPath((Join-Path $repoRoot "assets\github_auth\token"))
$discordConfigPath = [IO.Path]::GetFullPath((Join-Path $repoRoot "assets\discord\config.json"))
$discordBotTokenPath = [IO.Path]::GetFullPath((Join-Path $repoRoot "assets\discord\bot-token"))
$discordRuntimeRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "assets\discord\runtime"))
$discordStatusTokenPath = [IO.Path]::GetFullPath((Join-Path $discordRuntimeRoot "portal-status-token"))
$discordGatewayClientTokenPath = [IO.Path]::GetFullPath((Join-Path $discordRuntimeRoot "gateway-client-token"))
$legacyDiscordStatusTokenPath = [IO.Path]::GetFullPath((Join-Path $stateRoot "discord-status-token"))
$legacyDiscordGatewayClientTokenPath = [IO.Path]::GetFullPath((Join-Path $stateRoot "discord-gateway-client-token"))
$discordRecoveryCommand = '.\runtime\discord\Import-DiscordCredential.ps1 -ApplicationId "<AURELIA_APPLICATION_ID>" -FromClipboard'
$portalImage = "one-man-company/company-portal:local"
$portalContainer = "omc-portal"
$legacyDiscordContainer = "omc-discord-aurora"
$companyNetwork = "one-man-company"
$portalVersion = "10"

foreach ($resolvedPath in @($stateRoot, $bridgeTokenPath, $mergeWatcherPath, $incidentWatcherPath,
  $ownerRuntimeRoot, $ownerCredentialPath,
  $discordStartPath, $githubTokenPath, $discordConfigPath, $discordBotTokenPath,
  $discordRuntimeRoot, $discordStatusTokenPath, $discordGatewayClientTokenPath,
  $legacyDiscordStatusTokenPath, $legacyDiscordGatewayClientTokenPath)) {
  Get-LaAziendaRepositoryRelativePath -RepositoryRoot $repoRoot -CandidatePath $resolvedPath | Out-Null
}
$hrmStatePrefix = "$stateRoot$([IO.Path]::DirectorySeparatorChar)"
if ($discordRuntimeRoot.StartsWith($hrmStatePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Discord credentials must remain outside the HR Manager state mount."
}
if ($ownerRuntimeRoot.StartsWith($hrmStatePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "The owner credential must remain outside the HR Manager state mount."
}
if ($ownerRuntimeRoot -eq $discordRuntimeRoot) {
  throw "Owner and Discord credentials must use separate host boundaries."
}
foreach ($ownerSecretPath in @($ownerCredentialPath)) {
  $relativeOwnerSecretPath = Get-LaAziendaRepositoryRelativePath -RepositoryRoot $repoRoot -CandidatePath $ownerSecretPath
  & git -C $repoRoot check-ignore --quiet -- $relativeOwnerSecretPath
  if ($LASTEXITCODE -ne 0) { throw "The owner credential must remain Git-ignored." }
}
foreach ($discordSecretPath in @($discordStatusTokenPath, $discordGatewayClientTokenPath)) {
  $relativeDiscordSecretPath = Get-LaAziendaRepositoryRelativePath -RepositoryRoot $repoRoot -CandidatePath $discordSecretPath
  & git -C $repoRoot check-ignore --quiet -- $relativeDiscordSecretPath
  if ($LASTEXITCODE -ne 0) { throw "Discord runtime credentials must remain Git-ignored." }
}

function Get-OrCreateRandomToken([string]$Path, [string]$Label) {
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    $token = [IO.File]::ReadAllText($Path).Trim()
  } else {
    $tokenBytes = New-Object byte[] 32
    $tokenGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
      $tokenGenerator.GetBytes($tokenBytes)
      $token = [Convert]::ToBase64String($tokenBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    } finally {
      $tokenGenerator.Dispose()
      [Array]::Clear($tokenBytes, 0, $tokenBytes.Length)
    }
    [IO.File]::WriteAllText($Path, $token, (New-Object Text.UTF8Encoding($false)))
  }
  if ($token -notmatch '^[A-Za-z0-9_-]{43,128}$') { throw "$Label is invalid." }
  return $token
}

function Get-TokenFingerprint([string]$Token) {
  $tokenBytes = [Text.Encoding]::UTF8.GetBytes($Token)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return -join ($sha256.ComputeHash($tokenBytes) | ForEach-Object { $_.ToString("x2") })
  } finally {
    $sha256.Dispose()
    [Array]::Clear($tokenBytes, 0, $tokenBytes.Length)
  }
}

function Get-OwnerSessionVerifier([string]$Credential) {
  $domainBytes = [Text.Encoding]::UTF8.GetBytes("laazienda:owner-credential:v1$([char]0)")
  $credentialBytes = [Text.Encoding]::UTF8.GetBytes($Credential)
  $payloadBytes = New-Object byte[] ($domainBytes.Length + $credentialBytes.Length)
  [Array]::Copy($domainBytes, 0, $payloadBytes, 0, $domainBytes.Length)
  [Array]::Copy($credentialBytes, 0, $payloadBytes, $domainBytes.Length, $credentialBytes.Length)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return -join ($sha256.ComputeHash($payloadBytes) | ForEach-Object { $_.ToString("x2") })
  } finally {
    $sha256.Dispose()
    [Array]::Clear($domainBytes, 0, $domainBytes.Length)
    [Array]::Clear($credentialBytes, 0, $credentialBytes.Length)
    [Array]::Clear($payloadBytes, 0, $payloadBytes.Length)
  }
}

foreach ($ownerAncestor in @($repoRoot, $assetsRoot, $ownerRoot)) {
  if (Test-Path -LiteralPath $ownerAncestor) {
    $ownerAncestorItem = Get-Item -LiteralPath $ownerAncestor -Force
    if (($ownerAncestorItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing a reparse point in the owner credential boundary."
    }
  }
}
New-Item -ItemType Directory -Force -Path $stateRoot, $discordRuntimeRoot, $ownerRuntimeRoot | Out-Null
foreach ($ownerBoundaryPath in @($ownerRoot, $ownerRuntimeRoot, $ownerCredentialPath)) {
  if (Test-Path -LiteralPath $ownerBoundaryPath) {
    $ownerBoundaryItem = Get-Item -LiteralPath $ownerBoundaryPath -Force
    if (($ownerBoundaryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing a reparse point in the owner credential boundary."
    }
  }
}
if (-not (Test-Path -LiteralPath $bridgeTokenPath -PathType Leaf)) {
  $tokenBytes = New-Object byte[] 32
  $tokenGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $tokenGenerator.GetBytes($tokenBytes) } finally { $tokenGenerator.Dispose() }
  $bridgeToken = [Convert]::ToBase64String($tokenBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  [IO.File]::WriteAllText($bridgeTokenPath, $bridgeToken, (New-Object Text.UTF8Encoding($false)))
} else {
  $bridgeToken = [IO.File]::ReadAllText($bridgeTokenPath).Trim()
}
if ($bridgeToken.Length -lt 32) { throw "The local runtime bridge token is invalid." }
$ownerCredential = Get-OrCreateRandomToken $ownerCredentialPath "The owner session credential"
if ([IO.File]::ReadAllText($ownerCredentialPath) -cne $ownerCredential) {
  throw "The owner credential file must contain only the credential value."
}
$ownerCredentialVerifier = Get-OwnerSessionVerifier $ownerCredential
$ownerCredentialVersion = $ownerCredentialVerifier
if ($ownerCredential -ceq $bridgeToken) { throw "Owner and runtime bridge credentials must be independent." }
$discordStatusToken = Get-OrCreateRandomToken $discordStatusTokenPath "The Discord portal-status token"
$discordStatusVersion = Get-TokenFingerprint $discordStatusToken
$discordGatewayClientToken = Get-OrCreateRandomToken $discordGatewayClientTokenPath "The Discord gateway-client token"
if ($discordStatusToken -ceq $discordGatewayClientToken) { throw "Discord portal and gateway-client tokens must be independent." }
if ($ownerCredential -ceq $discordStatusToken -or $ownerCredential -ceq $discordGatewayClientToken) {
  throw "Owner and Discord credentials must be independent."
}
$discordGatewayClientToken = $null
$worktreeState = @(& git -C $repoRoot status --porcelain --untracked-files=normal 2>$null)
if ($LASTEXITCODE -eq 0 -and $worktreeState.Count -eq 0) {
  $sourceCommit = (& git -C $repoRoot rev-parse HEAD 2>$null).Trim()
  if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[a-f0-9]{40}$') { $sourceCommit = "" }
} else {
  $sourceCommit = ""
  Write-Warning "The worktree is not clean, so automated incidents will not claim an inaccurate source commit."
}

$network = & docker network ls --filter "name=^$companyNetwork$" --format "{{.Name}}"
if ($network -ne $companyNetwork) {
  & docker network create $companyNetwork | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The private company network could not be created." }
}

$portalImageId = & docker image ls --filter "reference=$portalImage" --format "{{.ID}}"
if ($BuildImages -or -not $portalImageId) {
  & docker build --file (Join-Path $PSScriptRoot "portal\Dockerfile") --tag $portalImage $repoRoot
  if ($LASTEXITCODE -ne 0) { throw "The Company Portal image could not be built." }
}

$portalId = & docker container ls --all --filter "name=^$portalContainer$" --format "{{.ID}}"
if ($portalId) {
  $portalLabels = (& docker container inspect --format "{{json .Config.Labels}}" $portalContainer | ConvertFrom-Json)
  $existingVersion = [string]$portalLabels.'one-man-company.portal-version'
  $existingDiscordStatusVersion = [string]$portalLabels.'one-man-company.discord-status-version'
  $existingOwnerCredentialVersion = [string]$portalLabels.'one-man-company.owner-session-version'
  if ($BuildImages -or $existingVersion -ne $portalVersion -or
      $existingDiscordStatusVersion -ne $discordStatusVersion -or
      $existingOwnerCredentialVersion -ne $ownerCredentialVersion) {
    & docker container rm --force $portalContainer | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "The obsolete Company Portal container could not be replaced." }
    $portalId = $null
  }
}

if (-not $portalId) {
  & docker volume create omc-portal-d1 | Out-Null
  & docker create --name $portalContainer `
    --label "one-man-company.portal=true" `
    --label "one-man-company.portal-version=$portalVersion" `
    --label "one-man-company.discord-status-version=$discordStatusVersion" `
    --label "one-man-company.owner-session-version=$ownerCredentialVersion" `
    --restart unless-stopped `
    --network $companyNetwork `
    --publish "127.0.0.1:3002:3000" `
    --env "RUNTIME_BRIDGE_TOKEN=$bridgeToken" `
    --env "OWNER_SESSION_VERIFIER=$ownerCredentialVerifier" `
    --env "DISCORD_STATUS_TOKEN=$discordStatusToken" `
    --env "SOURCE_COMMIT=$sourceCommit" `
    --volume "omc-portal-d1:/app/.wrangler" `
    $portalImage | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The Company Portal container could not be created." }
}
$portalEnvironmentJson = & docker container inspect --format "{{json .Config.Env}}" $portalContainer
if ($LASTEXITCODE -ne 0) { throw "The Company Portal environment could not be verified." }
$portalEnvironment = @($portalEnvironmentJson | ConvertFrom-Json)
if (@($portalEnvironment | Where-Object { $_ -like "OWNER_SESSION_CREDENTIAL=*" }).Count -gt 0) {
  throw "The Company Portal must never contain the raw owner credential."
}
$configuredOwnerVerifiers = @($portalEnvironment | Where-Object { $_ -like "OWNER_SESSION_VERIFIER=*" })
if ($configuredOwnerVerifiers.Count -ne 1 -or
    $configuredOwnerVerifiers[0] -cne "OWNER_SESSION_VERIFIER=$ownerCredentialVerifier") {
  throw "The Company Portal owner verifier does not match the host credential."
}
$ownerCredential = $null
$ownerCredentialVerifier = $null
$discordStatusToken = $null

$portalStatus = (& docker container inspect --format "{{.State.Status}}" $portalContainer).Trim()
if ($portalStatus -ne "running") {
  & docker start $portalContainer | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The Company Portal container could not be started." }
}

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:3002/api/company" -Headers @{ "x-runtime-bridge-token" = $bridgeToken } -TimeoutSec 2 | Out-Null
    $ready = $true
    break
  } catch {
    Start-Sleep -Seconds 1
  }
}
if (-not $ready) { throw "The Company Portal did not become ready on loopback." }

foreach ($legacyDiscordTokenPath in @($legacyDiscordStatusTokenPath, $legacyDiscordGatewayClientTokenPath)) {
  if (Test-Path -LiteralPath $legacyDiscordTokenPath -PathType Leaf) {
    Remove-Item -LiteralPath $legacyDiscordTokenPath -Force
  }
}

& (Join-Path $PSScriptRoot "bridge.ps1") `
  -ControlUrl "http://127.0.0.1:3002" `
  -ContainerControlUrl "http://omc-portal:3000" `
  -BridgeToken $bridgeToken `
  -BuildImage:$BuildImages
if ($LASTEXITCODE -ne 0) { throw "The HR Manager bootstrap failed." }

if (-not $SkipMergeWatcher) {
  if (-not (Test-Path -LiteralPath $mergeWatcherPath -PathType Leaf)) { throw "The GitHub merge watcher is missing." }
  $powerShellPath = (Get-Process -Id $PID).Path
  $watcherArguments = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$mergeWatcherPath`"",
    "-RepositoryRoot", "`"$repoRoot`"", "-ControlUrl", "http://127.0.0.1:3002"
  )
  Start-Process -FilePath $powerShellPath -ArgumentList $watcherArguments -WorkingDirectory $repoRoot -WindowStyle Hidden | Out-Null
}

if (-not $SkipIncidentWatcher) {
  if (-not (Test-Path -LiteralPath $incidentWatcherPath -PathType Leaf)) { throw "The system incident watcher is missing." }
  if (Test-Path -LiteralPath $githubTokenPath -PathType Leaf) {
    $powerShellPath = (Get-Process -Id $PID).Path
    $incidentWatcherArguments = @(
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$incidentWatcherPath`"",
      "-RepositoryRoot", "`"$repoRoot`"", "-ControlUrl", "http://127.0.0.1:3002"
    )
    Start-Process -FilePath $powerShellPath -ArgumentList $incidentWatcherArguments -WorkingDirectory $repoRoot -WindowStyle Hidden | Out-Null
  } else {
    Write-Warning "System incident detection is active, but automatic GitHub issue filing is waiting for the ignored GitHub credential."
  }
}

$legacyDiscordId = & docker container ls --all --filter "name=^$legacyDiscordContainer$" --format "{{.ID}}"
if ($LASTEXITCODE -ne 0) { throw "Docker could not list the legacy Discord adapter safely." }
if ($legacyDiscordId) {
  $legacyDiscordLabel = [string](& docker container inspect --format '{{index .Config.Labels "one-man-company.discord-adapter"}}' $legacyDiscordContainer)
  if ($LASTEXITCODE -ne 0) { throw "The legacy Discord adapter container could not be inspected safely." }
  $legacyDiscordLabel = $legacyDiscordLabel.Trim()
  if ($legacyDiscordLabel -ne "aurora") { throw "The legacy Discord adapter container name belongs to another workload." }
  & docker container rm --force $legacyDiscordContainer | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The legacy Aurora Discord adapter could not be retired." }
}

if (-not $SkipDiscord) {
  if (-not (Test-Path -LiteralPath $discordStartPath -PathType Leaf)) { throw "The Aurelia Discord adapter starter is missing." }
  try {
    & $discordStartPath -CleanupOnly
    if ($LASTEXITCODE -ne 0) { throw "Discord orphan cleanup returned a non-zero status." }
  } catch {
    Write-Warning "Aurelia's orphan candidate cleanup or interrupted-swap recovery did not complete. Company startup will continue, but Discord reporting may be unavailable or duplicated until local recovery succeeds."
  }

  $discordConfigurationIssue = $null
  $discordEmployeeId = $null
  if (-not (Test-Path -LiteralPath $discordConfigPath -PathType Leaf)) {
    $discordConfigurationIssue = "Aurelia's Discord application config is missing."
  } else {
    try {
      $discordEmployeeId = [string]((Get-Content -Raw -LiteralPath $discordConfigPath | ConvertFrom-Json).employeeId)
    } catch {
      $discordConfigurationIssue = "Aurelia's Discord application config is not valid JSON."
    }
    if (-not $discordConfigurationIssue -and $discordEmployeeId -cne "employee-hrm") {
      $discordConfigurationIssue = if ($discordEmployeeId -ceq "employee-aurora") {
        "The legacy Aurora Discord config cannot be used for Aurelia."
      } else {
        "The Discord config is not bound to Aurelia's employee-hrm record."
      }
    }
  }
  if (-not $discordConfigurationIssue -and -not (Test-Path -LiteralPath $discordBotTokenPath -PathType Leaf)) {
    $discordConfigurationIssue = "Aurelia's Discord bot token is missing."
  }

  if ($discordConfigurationIssue) {
    Write-Warning "$discordConfigurationIssue Company startup will continue without restarting the Discord adapter."
    Write-Warning "Copy Aurelia's bot token, then run: $discordRecoveryCommand"
  } else {
    try {
      & $discordStartPath -BuildImage:$BuildImages
      if ($LASTEXITCODE -ne 0) { throw "Discord adapter startup returned a non-zero status." }
    } catch {
      Write-Warning "Aurelia's Discord credential, replacement, or verified rollback did not complete. Company startup will continue, but Discord reporting may be unavailable."
      Write-Warning "Copy Aurelia's bot token, then run: $discordRecoveryCommand"
    }
  }
}

Write-Output "Company Portal and the configured workforce services are running on http://localhost:3002."
