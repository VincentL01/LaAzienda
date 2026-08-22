[CmdletBinding()]
param(
  [string]$StatusTokenPath = "",
  [switch]$CleanupOnly,
  [switch]$BuildImage
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$pathSafetyPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\Path-Safety.ps1"))
if (-not (Test-Path -LiteralPath $pathSafetyPath -PathType Leaf)) {
  throw "The repository path-safety helper is unavailable."
}
$pathSafetyItem = Get-Item -LiteralPath $pathSafetyPath -Force
if (($pathSafetyItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "Refusing a reparse point for the repository path-safety helper."
}
. $pathSafetyPath
$configPath = [IO.Path]::GetFullPath((Join-Path $repoRoot "assets\discord\config.json"))
$botTokenPath = [IO.Path]::GetFullPath((Join-Path $repoRoot "assets\discord\bot-token"))
$discordRuntimeRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "assets\discord\runtime"))
$gatewayClientTokenPath = [IO.Path]::GetFullPath((Join-Path $discordRuntimeRoot "gateway-client-token"))
$scopedTokenPath = if ($StatusTokenPath) {
  [IO.Path]::GetFullPath($StatusTokenPath)
} else {
  [IO.Path]::GetFullPath((Join-Path $discordRuntimeRoot "portal-status-token"))
}
if ($StatusTokenPath) {
  $discordRuntimePrefix = "$discordRuntimeRoot$([IO.Path]::DirectorySeparatorChar)"
  if (-not $scopedTokenPath.StartsWith($discordRuntimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "A custom portal-status token must stay inside the ignored Discord-only runtime directory."
  }
}
if ([string]::Equals($gatewayClientTokenPath, $scopedTokenPath, [StringComparison]::OrdinalIgnoreCase)) {
  throw "The gateway-client token must use a path distinct from the portal-status token."
}
$adapterImage = "one-man-company/discord-aurelia:local"
$gatewayImage = "one-man-company/discord-status-gateway:local"
$adapterContainer = "omc-discord-aurelia"
$adapterCandidate = "$adapterContainer-candidate"
$adapterBackup = "$adapterContainer-previous"
$gatewayContainer = "omc-discord-status-gateway"
$gatewayCandidate = "$gatewayContainer-candidate"
$gatewayBackup = "$gatewayContainer-previous"
$companyNetwork = "one-man-company"
$discordNetwork = "one-man-company-discord"
$adapterLabelKey = "one-man-company.discord-adapter"
$adapterLabelValue = "aurelia"
$gatewayLabelKey = "one-man-company.discord-status-gateway"
$gatewayLabelValue = "aurelia"

foreach ($path in @($configPath, $botTokenPath, $discordRuntimeRoot, $gatewayClientTokenPath,
  $scopedTokenPath, $PSScriptRoot, (Join-Path $PSScriptRoot "Dockerfile"),
  (Join-Path $PSScriptRoot "Gateway.Dockerfile"))) {
  $resolved = [IO.Path]::GetFullPath($path)
  Get-LaAziendaRepositoryRelativePath -RepositoryRoot $repoRoot -CandidatePath $resolved | Out-Null
}
foreach ($secretPath in @($configPath, $botTokenPath, $gatewayClientTokenPath, $scopedTokenPath)) {
  $relativeSecretPath = Get-LaAziendaRepositoryRelativePath -RepositoryRoot $repoRoot -CandidatePath $secretPath
  & git -C $repoRoot check-ignore --quiet -- $relativeSecretPath
  if ($LASTEXITCODE -ne 0) { throw "Discord runtime material must remain Git-ignored." }
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "Docker CLI is unavailable." }

function Get-ContainerId([string]$Name) {
  $id = [string](& docker container ls --all --filter "name=^$Name$" --format "{{.ID}}")
  if ($LASTEXITCODE -ne 0) { throw "Docker could not inspect the reserved Discord container names." }
  return $id.Trim()
}

function Test-OwnedContainer([string]$Name, [string]$LabelKey, [string]$LabelValue) {
  if (-not (Get-ContainerId $Name)) { return $false }
  $label = [string](& docker container inspect --format "{{index .Config.Labels `"$LabelKey`"}}" $Name)
  if ($LASTEXITCODE -ne 0) { throw "The reserved Discord container could not be inspected safely." }
  if ($label.Trim() -cne $LabelValue) { throw "The reserved Discord container name belongs to another workload: $Name" }
  return $true
}

function Remove-OwnedContainer([string]$Name, [string]$LabelKey, [string]$LabelValue) {
  if (Test-OwnedContainer $Name $LabelKey $LabelValue) {
    & docker container rm --force $Name | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "The owned Discord container could not be removed: $Name" }
  }
}

function Wait-HealthyContainer([string]$Name, [int]$Attempts = 25) {
  for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
    $state = [string](& docker container inspect --format "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}" $Name 2>$null)
    if ($LASTEXITCODE -eq 0 -and $state.Trim() -eq "running|healthy") { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Get-ContainerStatus([string]$Name) {
  $status = [string](& docker container inspect --format "{{.State.Status}}" $Name)
  if ($LASTEXITCODE -ne 0) { throw "The Discord container state could not be inspected: $Name" }
  return $status.Trim()
}

function Start-AndVerifyOwnedContainer(
  [string]$Name,
  [string]$LabelKey,
  [string]$LabelValue,
  [string]$Description
) {
  if (-not (Test-OwnedContainer $Name $LabelKey $LabelValue)) {
    throw "$Description is missing from its reserved container name."
  }
  if ((Get-ContainerStatus $Name) -ne "running") {
    & docker container start $Name | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "$Description could not be restarted." }
  }
  if (-not (Wait-HealthyContainer $Name 25)) { throw "$Description did not recover readiness." }
}

function Restore-BackupContainer(
  [string]$Stable,
  [string]$Backup,
  [string]$LabelKey,
  [string]$LabelValue,
  [string]$Description
) {
  if (Test-OwnedContainer $Stable $LabelKey $LabelValue) {
    Remove-OwnedContainer $Stable $LabelKey $LabelValue
  }
  if (-not (Test-OwnedContainer $Backup $LabelKey $LabelValue)) {
    throw "$Description rollback backup is missing."
  }
  & docker container rename $Backup $Stable
  if ($LASTEXITCODE -ne 0) { throw "$Description rollback rename failed." }
  Start-AndVerifyOwnedContainer $Stable $LabelKey $LabelValue "Restored $Description"
}

function Stage-StableContainer(
  [string]$Stable,
  [string]$Backup,
  [string]$LabelKey,
  [string]$LabelValue,
  [string]$Description
) {
  & docker container stop $Stable | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "$Description could not be stopped for replacement." }
  & docker container rename $Stable $Backup
  if ($LASTEXITCODE -eq 0) { return }
  try {
    Start-AndVerifyOwnedContainer $Stable $LabelKey $LabelValue "Previous $Description"
  } catch {
    throw "$Description staging failed and recovery of the stopped stable container also failed: $($_.Exception.Message)"
  }
  throw "$Description could not be staged for rollback; the previous stable container was restarted and verified."
}

function Recover-InterruptedSwap([string]$Stable, [string]$Backup, [string]$LabelKey, [string]$LabelValue) {
  $hasBackup = Test-OwnedContainer $Backup $LabelKey $LabelValue
  $hasStable = Test-OwnedContainer $Stable $LabelKey $LabelValue
  if (-not $hasBackup) {
    if ($hasStable -and (Get-ContainerStatus $Stable) -ne "running") {
      Start-AndVerifyOwnedContainer $Stable $LabelKey $LabelValue "Interrupted stable Discord container"
    }
    return
  }
  if ($hasStable) {
    if (Wait-HealthyContainer $Stable 25) {
      Remove-OwnedContainer $Backup $LabelKey $LabelValue
      return
    }
    Remove-OwnedContainer $Stable $LabelKey $LabelValue
  }
  Restore-BackupContainer $Stable $Backup $LabelKey $LabelValue "Interrupted Discord container"
}

function Promote-GatewayCandidate {
  $hadStable = Test-OwnedContainer $gatewayContainer $gatewayLabelKey $gatewayLabelValue
  if ($hadStable) {
    Stage-StableContainer $gatewayContainer $gatewayBackup $gatewayLabelKey $gatewayLabelValue "Discord status gateway"
  }
  try {
    & docker container rename $gatewayCandidate $gatewayContainer
    if ($LASTEXITCODE -ne 0) { throw "The verified Discord status gateway could not be promoted." }
    if (-not (Wait-HealthyContainer $gatewayContainer 5)) { throw "The promoted Discord status gateway lost readiness." }
  } catch {
    $promotionFailure = $_.Exception.Message
    try {
      Remove-OwnedContainer $gatewayContainer $gatewayLabelKey $gatewayLabelValue
      if ($hadStable) {
        Restore-BackupContainer $gatewayContainer $gatewayBackup $gatewayLabelKey $gatewayLabelValue "Discord status gateway"
      }
    } catch {
      throw "Discord status gateway promotion failed ($promotionFailure). Rollback also failed: $($_.Exception.Message)"
    }
    if ($hadStable) { throw "Discord status gateway promotion failed; the previous container was restored and verified: $promotionFailure" }
    throw "Discord status gateway promotion failed: $promotionFailure"
  }
  Remove-OwnedContainer $gatewayBackup $gatewayLabelKey $gatewayLabelValue
}

function Promote-AdapterCandidate {
  $hadStable = Test-OwnedContainer $adapterContainer $adapterLabelKey $adapterLabelValue
  if ($hadStable) {
    Stage-StableContainer $adapterContainer $adapterBackup $adapterLabelKey $adapterLabelValue "Aurelia Discord adapter"
  }
  try {
    & docker container rename $adapterCandidate $adapterContainer
    if ($LASTEXITCODE -ne 0) { throw "The verified Aurelia Discord adapter could not be promoted." }
    if (-not (Wait-HealthyContainer $adapterContainer 5)) { throw "The promoted Aurelia Discord adapter lost readiness." }
  } catch {
    $promotionFailure = $_.Exception.Message
    try {
      Remove-OwnedContainer $adapterContainer $adapterLabelKey $adapterLabelValue
      if ($hadStable) {
        Restore-BackupContainer $adapterContainer $adapterBackup $adapterLabelKey $adapterLabelValue "Aurelia Discord adapter"
      }
    } catch {
      throw "Aurelia Discord adapter promotion failed ($promotionFailure). Rollback also failed: $($_.Exception.Message)"
    }
    if ($hadStable) { throw "Aurelia Discord adapter promotion failed; the previous container was restored and verified: $promotionFailure" }
    throw "Aurelia Discord adapter promotion failed: $promotionFailure"
  }
  Remove-OwnedContainer $adapterBackup $adapterLabelKey $adapterLabelValue
}

Remove-OwnedContainer $adapterCandidate $adapterLabelKey $adapterLabelValue
Remove-OwnedContainer $gatewayCandidate $gatewayLabelKey $gatewayLabelValue
Recover-InterruptedSwap $gatewayContainer $gatewayBackup $gatewayLabelKey $gatewayLabelValue
Recover-InterruptedSwap $adapterContainer $adapterBackup $adapterLabelKey $adapterLabelValue
if ($CleanupOnly) { return }

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Missing assets/discord/config.json." }
if (-not (Test-Path -LiteralPath $botTokenPath -PathType Leaf)) { throw "Missing assets/discord/bot-token." }

$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
if ([string]$config.applicationId -notmatch '^\d{17,20}$') { throw "Discord config has an invalid applicationId." }
$employeeId = [string]$config.employeeId
if ($employeeId -cne "employee-hrm") { throw "The Aurelia Discord adapter must be bound to employee-hrm." }
$botToken = [IO.File]::ReadAllText($botTokenPath).Trim()
if ($botToken.Length -lt 32) { throw "The Discord bot token is invalid." }
try {
  $application = Invoke-RestMethod -Uri "https://discord.com/api/v10/oauth2/applications/@me" `
    -Headers @{ Authorization = "Bot $botToken"; "User-Agent" = "LaAzienda-Aurelia/0.2" } `
    -Method Get -TimeoutSec 15
} catch {
  $botToken = $null
  throw "Discord did not accept the local Aurelia bot credential."
}
$ceoUserId = [string]$application.owner.id
if ([string]$application.id -ne [string]$config.applicationId -or $ceoUserId -notmatch '^\d{17,20}$' -or [string]$application.name -cne "Aurelia") {
  $botToken = $null
  throw "The Discord credential does not belong to the configured CEO-owned Aurelia application."
}
$botToken = $null
$application = $null

if (-not (Test-Path -LiteralPath $scopedTokenPath -PathType Leaf)) {
  throw "The dedicated Discord portal-status token is missing; start the Company Portal first."
}
if (-not (Test-Path -LiteralPath $gatewayClientTokenPath -PathType Leaf)) {
  throw "The Discord gateway-client token is missing; start the Company Portal first."
}
$statusToken = [IO.File]::ReadAllText($scopedTokenPath).Trim()
$gatewayClientToken = [IO.File]::ReadAllText($gatewayClientTokenPath).Trim()
try {
  if ($statusToken -notmatch '^[A-Za-z0-9_-]{43,128}$') { throw "The dedicated Discord portal-status token is invalid." }
  if ($gatewayClientToken -notmatch '^[A-Za-z0-9_-]{43,128}$') { throw "The Discord gateway-client token is invalid." }
  if ($statusToken -ceq $gatewayClientToken) { throw "Discord portal and gateway-client tokens must be independent." }
} finally {
  $statusToken = $null
  $gatewayClientToken = $null
}

$existingCompanyNetwork = [string](& docker network ls --filter "name=^$companyNetwork$" --format "{{.Name}}")
if ($LASTEXITCODE -ne 0 -or $existingCompanyNetwork.Trim() -cne $companyNetwork) { throw "The private company Docker network is unavailable." }
$existingDiscordNetwork = [string](& docker network ls --filter "name=^$discordNetwork$" --format "{{.Name}}")
if ($LASTEXITCODE -ne 0) { throw "Docker could not inspect the dedicated Discord network." }
if ($existingDiscordNetwork.Trim()) {
  $networkLabel = [string](& docker network inspect --format '{{index .Labels "one-man-company.discord-network"}}' $discordNetwork)
  if ($LASTEXITCODE -ne 0 -or $networkLabel.Trim() -cne "true") { throw "The reserved Discord network belongs to another workload." }
} else {
  & docker network create --label "one-man-company.discord-network=true" $discordNetwork | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The dedicated Discord network could not be created." }
}

$adapterImageId = [string](& docker image ls --filter "reference=$adapterImage" --format "{{.ID}}")
$gatewayImageId = [string](& docker image ls --filter "reference=$gatewayImage" --format "{{.ID}}")
if ($BuildImage -or -not $adapterImageId.Trim()) {
  & docker build --file (Join-Path $PSScriptRoot "Dockerfile") --tag $adapterImage $PSScriptRoot
  if ($LASTEXITCODE -ne 0) { throw "The Aurelia Discord adapter image could not be built." }
}
if ($BuildImage -or -not $gatewayImageId.Trim()) {
  & docker build --file (Join-Path $PSScriptRoot "Gateway.Dockerfile") --tag $gatewayImage $PSScriptRoot
  if ($LASTEXITCODE -ne 0) { throw "The Discord status gateway image could not be built." }
}

$gatewayCreateArgs = @(
  "create", "--name", $gatewayCandidate,
  "--label", "$gatewayLabelKey=$gatewayLabelValue",
  "--restart", "unless-stopped",
  "--network", $companyNetwork,
  "--read-only",
  "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges:true",
  "--tmpfs", "/tmp:rw,noexec,nosuid,size=8m",
  "--mount", "type=bind,src=$scopedTokenPath,dst=/run/secrets/company_status_token,readonly",
  "--mount", "type=bind,src=$gatewayClientTokenPath,dst=/run/secrets/gateway_client_token,readonly",
  $gatewayImage
)
& docker @gatewayCreateArgs | Out-Null
if ($LASTEXITCODE -ne 0) { throw "The candidate Discord status gateway could not be created." }
try {
  & docker network connect $discordNetwork $gatewayCandidate
  if ($LASTEXITCODE -ne 0) { throw "The candidate Discord status gateway could not join its dedicated network." }
  & docker container start $gatewayCandidate | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Wait-HealthyContainer $gatewayCandidate)) { throw "The candidate Discord status gateway did not become ready." }
  Promote-GatewayCandidate
} catch {
  Remove-OwnedContainer $gatewayCandidate $gatewayLabelKey $gatewayLabelValue
  throw
}

$adapterCreateArgs = @(
  "create", "--name", $adapterCandidate,
  "--label", "$adapterLabelKey=$adapterLabelValue",
  "--restart", "unless-stopped",
  "--network", $discordNetwork,
  "--read-only",
  "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges:true",
  "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
  "--mount", "type=bind,src=$botTokenPath,dst=/run/secrets/discord_bot_token,readonly",
  "--mount", "type=bind,src=$gatewayClientTokenPath,dst=/run/secrets/gateway_client_token,readonly",
  "--env", "OMC_DISCORD_APPLICATION_ID=$($config.applicationId)",
  "--env", "OMC_DISCORD_CEO_USER_ID=$ceoUserId",
  $adapterImage
)
& docker @adapterCreateArgs | Out-Null
if ($LASTEXITCODE -ne 0) { throw "The candidate Aurelia Discord adapter could not be created." }
try {
  & docker container start $adapterCandidate | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Wait-HealthyContainer $adapterCandidate)) { throw "The candidate Aurelia Discord adapter did not become ready." }
  Promote-AdapterCandidate
} catch {
  Remove-OwnedContainer $adapterCandidate $adapterLabelKey $adapterLabelValue
  throw
}

Write-Output "Aurelia Discord adapter is running behind the isolated read-only status gateway."
