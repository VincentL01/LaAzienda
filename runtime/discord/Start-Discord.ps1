[CmdletBinding()]
param(
  [string]$PortalUrl = "http://127.0.0.1:3002",
  [string]$ContainerControlUrl = "http://omc-portal:3000",
  [string]$StatusTokenPath = "",
  [switch]$BuildImage
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$configPath = [IO.Path]::GetFullPath((Join-Path $repoRoot "assets\discord\config.json"))
$botTokenPath = [IO.Path]::GetFullPath((Join-Path $repoRoot "assets\discord\bot-token"))
$runtimeStateRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "runtime\state"))
$runtimeBridgeTokenPath = [IO.Path]::GetFullPath((Join-Path $runtimeStateRoot "runtime-bridge-token"))
$scopedTokenPath = if ($StatusTokenPath) {
  [IO.Path]::GetFullPath($StatusTokenPath)
} else {
  [IO.Path]::GetFullPath((Join-Path $runtimeStateRoot "discord-status-token"))
}
$image = "one-man-company/discord-aurora:local"
$container = "omc-discord-aurora"
$network = "one-man-company"

foreach ($path in @($configPath, $botTokenPath, $runtimeStateRoot, $runtimeBridgeTokenPath, $scopedTokenPath, $PSScriptRoot)) {
  if (-not $path.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Resolved Discord adapter path left the repository boundary."
  }
}
foreach ($secretPath in @($configPath, $botTokenPath, $scopedTokenPath)) {
  $relativeSecretPath = [IO.Path]::GetRelativePath($repoRoot, $secretPath).Replace('\', '/')
  & git -C $repoRoot check-ignore --quiet -- $relativeSecretPath
  if ($LASTEXITCODE -ne 0) { throw "Discord runtime material must remain Git-ignored." }
}
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Missing assets/discord/config.json." }
if (-not (Test-Path -LiteralPath $botTokenPath -PathType Leaf)) { throw "Missing assets/discord/bot-token." }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "Docker CLI is unavailable." }

$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
if ([string]$config.applicationId -notmatch '^\d{17,20}$') { throw "Discord config has an invalid applicationId." }
$employeeId = [string]$config.employeeId
if ($employeeId -notmatch '^employee-[A-Za-z0-9-]{1,100}$') { throw "Discord config has an invalid employeeId." }
$botToken = [IO.File]::ReadAllText($botTokenPath).Trim()
if ($botToken.Length -lt 32) { throw "The Discord bot token is invalid." }
try {
  $application = Invoke-RestMethod -Uri "https://discord.com/api/v10/oauth2/applications/@me" `
    -Headers @{ Authorization = "Bot $botToken"; "User-Agent" = "LaAzienda-Aurora/0.1" } `
    -Method Get -TimeoutSec 15
} catch {
  $botToken = $null
  throw "Discord did not accept the local Aurora bot credential."
}
$ceoUserId = [string]$application.owner.id
if ([string]$application.id -ne [string]$config.applicationId -or $ceoUserId -notmatch '^\d{17,20}$' -or [string]$application.name -cne "Aurora") {
  $botToken = $null
  throw "The Discord credential does not belong to the configured CEO-owned application."
}
$botToken = $null

if ($StatusTokenPath) {
  if (-not (Test-Path -LiteralPath $scopedTokenPath -PathType Leaf)) { throw "The dedicated Discord status token is missing." }
  $statusToken = [IO.File]::ReadAllText($scopedTokenPath).Trim()
} else {
  if (-not (Test-Path -LiteralPath $runtimeBridgeTokenPath -PathType Leaf)) {
    throw "The company runtime bridge token is unavailable; start the Company Portal first."
  }
  $runtimeBridgeToken = [IO.File]::ReadAllText($runtimeBridgeTokenPath).Trim()
  if ($runtimeBridgeToken.Length -lt 32) { throw "The company runtime bridge token is invalid." }
  $domainSeparatedInput = [Text.Encoding]::UTF8.GetBytes("one-man-company:discord-status:v1`0$runtimeBridgeToken")
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $statusToken = -join ($sha256.ComputeHash($domainSeparatedInput) | ForEach-Object { $_.ToString("x2") })
  } finally {
    $sha256.Dispose()
    [Array]::Clear($domainSeparatedInput, 0, $domainSeparatedInput.Length)
  }
  New-Item -ItemType Directory -Force -Path $runtimeStateRoot | Out-Null
  [IO.File]::WriteAllText($scopedTokenPath, $statusToken, [Text.UTF8Encoding]::new($false))
}
if ($statusToken.Length -lt 32) { throw "The Discord status token is invalid." }

$statusUri = "$($PortalUrl.TrimEnd('/'))/api/integrations/discord/status?employeeId=$([Uri]::EscapeDataString($employeeId))"
try {
  $snapshot = Invoke-RestMethod -Uri $statusUri -Headers @{ Authorization = "Bearer $statusToken" } -Method Get -TimeoutSec 10
} catch {
  throw "The Company Portal did not accept the scoped Discord status credential."
}
if ($snapshot.schemaVersion -ne "1" -or $snapshot.integrationEmployee.id -ne $employeeId -or $snapshot.integrationEmployee.name -cne "Aurora") {
  throw "The configured Discord employee must resolve exactly to Aurora before the adapter can start."
}

$existingNetwork = & docker network ls --filter "name=^$network$" --format "{{.Name}}"
if ($existingNetwork -ne $network) { throw "The private company Docker network is unavailable." }
$imageId = & docker image ls --filter "reference=$image" --format "{{.ID}}"
if ($BuildImage -or -not $imageId) {
  & docker build --file (Join-Path $PSScriptRoot "Dockerfile") --tag $image $PSScriptRoot
  if ($LASTEXITCODE -ne 0) { throw "The Aurora Discord adapter image could not be built." }
}

$existing = & docker container ls --all --filter "name=^$container$" --format "{{.ID}}"
if ($existing) {
  $adapterLabel = (& docker container inspect --format '{{index .Config.Labels "one-man-company.discord-adapter"}}' $container).Trim()
  if ($adapterLabel -ne "aurora") { throw "The reserved Aurora container name belongs to another workload." }
  & docker container rm --force $container | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The previous Aurora Discord adapter could not be replaced." }
}

$createArgs = @(
  "create", "--name", $container,
  "--label", "one-man-company.discord-adapter=aurora",
  "--restart", "unless-stopped",
  "--network", $network,
  "--read-only",
  "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges:true",
  "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
  "--mount", "type=bind,src=$botTokenPath,dst=/run/secrets/discord_bot_token,readonly",
  "--mount", "type=bind,src=$scopedTokenPath,dst=/run/secrets/company_status_token,readonly",
  "--env", "OMC_DISCORD_APPLICATION_ID=$($config.applicationId)",
  "--env", "OMC_DISCORD_CEO_USER_ID=$ceoUserId",
  "--env", "OMC_DISCORD_EMPLOYEE_ID=$employeeId",
  "--env", "OMC_CONTROL_URL=$($ContainerControlUrl.TrimEnd('/'))",
  $image
)
& docker @createArgs | Out-Null
if ($LASTEXITCODE -ne 0) { throw "The Aurora Discord adapter container could not be created." }
& docker start $container | Out-Null
if ($LASTEXITCODE -ne 0) { throw "The Aurora Discord adapter container could not be started." }

$ready = $false
for ($attempt = 0; $attempt -lt 25; $attempt++) {
  $containerState = (& docker container inspect --format "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}" $container).Trim()
  if ($LASTEXITCODE -ne 0) { break }
  if ($containerState -eq "running|healthy") {
    $ready = $true
    break
  }
  Start-Sleep -Seconds 2
}
if (-not $ready) {
  throw "Aurora did not complete command registration and Discord Gateway login within the readiness window."
}

Write-Output "Aurora Discord adapter is running with read-only company status access."
