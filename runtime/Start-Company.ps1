[CmdletBinding()]
param(
  [switch]$BuildImages,
  [switch]$SkipMergeWatcher
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$stateRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "state"))
$bridgeTokenPath = [IO.Path]::GetFullPath((Join-Path $stateRoot "runtime-bridge-token"))
$mergeWatcherPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "Watch-GitHubMerges.ps1"))
$portalImage = "one-man-company/company-portal:local"
$portalContainer = "omc-portal"
$companyNetwork = "one-man-company"
$portalVersion = "5"

foreach ($resolvedPath in @($stateRoot, $bridgeTokenPath, $mergeWatcherPath)) {
  if (-not $resolvedPath.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Resolved company runtime path left the repository boundary."
  }
}

New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
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
  if ($BuildImages -or $existingVersion -ne $portalVersion) {
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
    --restart unless-stopped `
    --network $companyNetwork `
    --publish "127.0.0.1:3000:3000" `
    --env "RUNTIME_BRIDGE_TOKEN=$bridgeToken" `
    --volume "omc-portal-d1:/app/.wrangler" `
    $portalImage | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The Company Portal container could not be created." }
}

$portalStatus = (& docker container inspect --format "{{.State.Status}}" $portalContainer).Trim()
if ($portalStatus -ne "running") {
  & docker start $portalContainer | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The Company Portal container could not be started." }
}

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/company" -Headers @{ "x-runtime-bridge-token" = $bridgeToken } -TimeoutSec 2 | Out-Null
    $ready = $true
    break
  } catch {
    Start-Sleep -Seconds 1
  }
}
if (-not $ready) { throw "The Company Portal did not become ready on loopback." }

& (Join-Path $PSScriptRoot "bridge.ps1") `
  -ControlUrl "http://127.0.0.1:3000" `
  -ContainerControlUrl "http://omc-portal:3000" `
  -BridgeToken $bridgeToken `
  -BuildImage:$BuildImages
if ($LASTEXITCODE -ne 0) { throw "The HR Manager bootstrap failed." }

if (-not $SkipMergeWatcher) {
  if (-not (Test-Path -LiteralPath $mergeWatcherPath -PathType Leaf)) { throw "The GitHub merge watcher is missing." }
  $powerShellPath = (Get-Process -Id $PID).Path
  $watcherArguments = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$mergeWatcherPath`"",
    "-RepositoryRoot", "`"$repoRoot`"", "-ControlUrl", "http://127.0.0.1:3000"
  )
  Start-Process -FilePath $powerShellPath -ArgumentList $watcherArguments -WorkingDirectory $repoRoot -WindowStyle Hidden | Out-Null
}

Write-Output "Company Portal, HR Manager, employee dispatcher, and GitHub merge watcher are running."
