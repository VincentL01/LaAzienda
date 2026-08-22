[CmdletBinding()]
param(
  [string]$ControlUrl = "http://localhost:3002",
  [string]$ContainerControlUrl = "",
  [string]$BridgeToken = $env:OMC_RUNTIME_BRIDGE_TOKEN,
  [switch]$BuildImage
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$authPath = [IO.Path]::GetFullPath((Join-Path $repoRoot "assets\agent_auth\auth.json"))
$githubTokenPath = [IO.Path]::GetFullPath((Join-Path $repoRoot "assets\github_auth\token"))
$stateRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "state"))
$skillCacheRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "training-center\cache\.agents\skills"))
$baseRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "agent"))
$hrmRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "hrm"))
$baseImage = "one-man-company/codex-employee:local"
$hrmImage = "one-man-company/hr-manager:local"
$companyNetwork = "one-man-company"
$hrmContainer = "omc-hrm"
$runtimeVersion = "9"
$controlUri = [Uri]$ControlUrl
$insideControlUrl = if ($ContainerControlUrl) { $ContainerControlUrl.TrimEnd('/') } else { "$($controlUri.Scheme)://host.docker.internal:$($controlUri.Port)" }

foreach ($resolvedPath in @($authPath, $githubTokenPath, $stateRoot, $skillCacheRoot, $baseRoot, $hrmRoot)) {
  if (-not $resolvedPath.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Resolved runtime path left the repository boundary."
  }
}
if (-not (Test-Path -LiteralPath $authPath -PathType Leaf)) {
  throw "Missing assets/agent_auth/auth.json. The bootstrap never reads or prints this file."
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker CLI is not available."
}
$authVersion = (Get-FileHash -LiteralPath $authPath -Algorithm SHA256).Hash.ToLowerInvariant()
$githubAuthVersion = if (Test-Path -LiteralPath $githubTokenPath -PathType Leaf) {
  (Get-FileHash -LiteralPath $githubTokenPath -Algorithm SHA256).Hash.ToLowerInvariant()
} else {
  "missing"
}
$network = & docker network ls --filter "name=^$companyNetwork$" --format "{{.Name}}"
if ($network -ne $companyNetwork) {
  throw "The private company Docker network is missing. Start infrastructure/mail/Start-Mail.ps1 first."
}

$headers = @{}
if ($BridgeToken) { $headers["x-runtime-bridge-token"] = $BridgeToken }
$controlBase = $ControlUrl.TrimEnd('/')
$workforce = Invoke-RestMethod -Uri "$controlBase/api/employees" -Headers $headers -Method Get
$hrm = $workforce.employees | Where-Object { $_.id -eq "employee-hrm" } | Select-Object -First 1
if (-not $hrm) { throw "The HR Manager employee record is missing from the control plane." }
if (-not $hrm.dockerSocketAccess) { throw "The HR Manager record does not hold the Docker socket policy." }
$otherSocketHolders = @($workforce.employees | Where-Object { $_.id -ne $hrm.id -and $_.dockerSocketAccess })
if ($otherSocketHolders.Count -gt 0) { throw "Docker socket policy violation: only the HR Manager may hold it." }

$baseImageId = & docker image ls --filter "reference=$baseImage" --format "{{.ID}}"
if ($BuildImage -or -not $baseImageId) {
  & docker build --tag $baseImage $baseRoot
  if ($LASTEXITCODE -ne 0) { throw "The Codex base employee image could not be built." }
}
$baseImageIdentity = (& docker image inspect --format "{{.Id}}" $baseImage).Trim()
if ($baseImageIdentity -notmatch '^sha256:[0-9a-f]{64}$') { throw "The Codex base employee image identity is invalid." }
$hrmImageId = & docker image ls --filter "reference=$hrmImage" --format "{{.ID}}"
if ($BuildImage -or -not $hrmImageId) {
  & docker build --tag $hrmImage $hrmRoot
  if ($LASTEXITCODE -ne 0) { throw "The HR Manager image could not be built." }
}
$hrmImageIdentity = (& docker image inspect --format "{{.Id}}" $hrmImage).Trim()
if ($hrmImageIdentity -notmatch '^sha256:[0-9a-f]{64}$') { throw "The HR Manager image identity is invalid." }

New-Item -ItemType Directory -Force -Path $stateRoot, $skillCacheRoot | Out-Null
$hrmStateRoot = [IO.Path]::GetFullPath((Join-Path $stateRoot $hrm.id))
$hrmWorkspace = [IO.Path]::GetFullPath((Join-Path $hrmStateRoot "workspace"))

function Test-ContainedRuntimePath([string]$Root, [string]$Candidate) {
  $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $resolvedCandidate = [IO.Path]::GetFullPath($Candidate)
  $prefix = "$resolvedRoot$([IO.Path]::DirectorySeparatorChar)"
  return $resolvedCandidate.Equals($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $resolvedCandidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-SafeRuntimeDirectory([string]$Root, [string]$RelativePath) {
  $resolvedRoot = [IO.Path]::GetFullPath($Root)
  if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
    throw "The HR Manager runtime root is not a directory."
  }
  $rootItem = Get-Item -LiteralPath $resolvedRoot -Force
  if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "The HR Manager runtime root cannot be a reparse point."
  }

  $current = $resolvedRoot
  foreach ($component in @($RelativePath -split '[\\/]' | Where-Object { $_ })) {
    if ($component -eq "." -or $component -eq "..") { throw "Unsafe HR Manager runtime directory component." }
    $current = [IO.Path]::GetFullPath((Join-Path $current $component))
    if (-not (Test-ContainedRuntimePath $resolvedRoot $current)) { throw "HR Manager runtime directory left its bind root." }
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "HR Manager runtime control path is not a real directory: $RelativePath"
      }
    } else {
      New-Item -ItemType Directory -Path $current | Out-Null
      $item = Get-Item -LiteralPath $current -Force
      if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "HR Manager runtime control directory could not be created safely: $RelativePath"
      }
    }
  }
  return $current
}

if (-not (Test-ContainedRuntimePath $stateRoot $hrmWorkspace)) { throw "Unsafe HR Manager workspace path." }
Assert-SafeRuntimeDirectory $stateRoot $hrm.id | Out-Null
Assert-SafeRuntimeDirectory $stateRoot (Join-Path $hrm.id "workspace") | Out-Null
foreach ($controlDirectory in @(
  ".company\training",
  ".company\runs",
  ".company\reconcile",
  ".company\dispatcher",
  ".company\dispatcher\terminal-outbox"
)) {
  Assert-SafeRuntimeDirectory $hrmWorkspace $controlDirectory | Out-Null
}
$hrmInstructions = "# $($hrm.name) - $($hrm.role)`n`nDepartment: $($hrm.department)`nEmployment type: executive`n`n$($hrm.systemPrompt)`n"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $hrmWorkspace "AGENTS.md"), $hrmInstructions, $utf8NoBom)

function Test-ExpectedBindMount([object]$Inspection, [string]$HostPath, [string]$ContainerPath, [bool]$ReadOnly) {
  $matches = @($Inspection.Mounts | Where-Object { $_.Type -eq "bind" -and $_.Destination -eq $ContainerPath })
  if ($matches.Count -ne 1 -or [bool]$matches[0].RW -eq $ReadOnly) { return $false }
  $actualSource = ([string]$matches[0].Source).TrimEnd('/', '\')
  $expectedSource = if ($HostPath.StartsWith('/')) { $HostPath.TrimEnd('/') } else { ([IO.Path]::GetFullPath($HostPath)).TrimEnd('/', '\') }
  $sourceCandidates = @($expectedSource, $expectedSource.Replace('\', '/'))
  if ($expectedSource -match '^([A-Za-z]):[\\/](.*)$') {
    $drive = $Matches[1].ToLowerInvariant()
    $tail = $Matches[2].Replace('\', '/')
    $sourceCandidates += "/run/desktop/mnt/host/$drive/$tail", "/host_mnt/$drive/$tail"
  }
  return [bool]($sourceCandidates | Where-Object { $_.TrimEnd('/', '\').Equals($actualSource, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1)
}

function Get-ManagedSecretSourceInspection([string]$Name, [string]$HostPath, [string]$ContainerPath) {
  $rawInspection = @(& docker container inspect $Name | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0 -or $rawInspection.Count -ne 1) { throw "Could not inspect the $Name credential source." }
  $inspection = $rawInspection[0]
  $labels = $inspection.Config.Labels
  $expectedMount = Test-ExpectedBindMount $inspection $HostPath $ContainerPath $true
  $managedKind = [string]$labels.'one-man-company.managed-kind'
  $legacyManaged = $managedKind -eq "" -and [string]$labels.'one-man-company.secret-version' -and $expectedMount
  if ($managedKind -ne "secret-source" -and -not $legacyManaged) {
    throw "Refusing to replace $Name because the name is occupied by an unrelated container."
  }
  return $inspection
}

function Ensure-SecretSource([string]$Name, [string]$HostPath, [string]$ContainerPath, [string]$Version, [string]$ImageIdentity) {
  $existing = & docker container ls --all --filter "name=^$Name$" --format "{{.ID}}"
  if ($existing) {
    $inspection = Get-ManagedSecretSourceInspection $Name $HostPath $ContainerPath
    $labels = $inspection.Config.Labels
    $actualImageIdentity = [string]$inspection.Image
    $expectedMount = Test-ExpectedBindMount $inspection $HostPath $ContainerPath $true
    if ([string]$labels.'one-man-company.secret-version' -eq $Version -and
        [string]$labels.'one-man-company.base-image-id' -eq $ImageIdentity -and
        $actualImageIdentity -eq $ImageIdentity -and $expectedMount) { return }
    & docker container rm --force $Name | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not replace the stale $Name credential source." }
  }
  & docker create --name $Name --label "one-man-company.managed-kind=secret-source" `
    --label "one-man-company.secret-version=$Version" `
    --label "one-man-company.base-image-id=$ImageIdentity" --entrypoint sh `
    --volume "$HostPath`:$ContainerPath`:ro" $ImageIdentity -c "exit 0" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not create the $Name credential source." }
  $created = Get-ManagedSecretSourceInspection $Name $HostPath $ContainerPath
  if ([string]$created.Image -ne $ImageIdentity -or -not (Test-ExpectedBindMount $created $HostPath $ContainerPath $true)) {
    throw "The $Name credential source failed independent image or read-only bind verification."
  }
}

Ensure-SecretSource "omc-auth-source" $authPath "/run/secrets/codex_auth" $authVersion $baseImageIdentity
if (Test-Path -LiteralPath $githubTokenPath -PathType Leaf) {
  Ensure-SecretSource "omc-github-source" $githubTokenPath "/run/secrets/github_token" $githubAuthVersion $baseImageIdentity
} else {
  $obsoleteGithubSource = & docker container ls --all --filter "name=^omc-github-source$" --format "{{.ID}}"
  if ($obsoleteGithubSource) {
    Get-ManagedSecretSourceInspection "omc-github-source" $githubTokenPath "/run/secrets/github_token" | Out-Null
    & docker container rm --force "omc-github-source" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not remove the obsolete managed GitHub credential source." }
  }
}

function Send-HrmRuntimeEvent([string]$RuntimeStatus, [string]$Detail, [string]$Identity) {
  $payload = @{
    action = "reportRuntime"
    employeeId = $hrm.id
    eventKey = "$($hrm.id):$RuntimeStatus`:$Identity"
    runtimeStatus = $RuntimeStatus
    detail = $Detail
  } | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri "$controlBase/api/employees" -Headers $headers -Method Post -ContentType "application/json" -Body $payload | Out-Null
}

$hrmId = & docker container ls --all --filter "name=^$hrmContainer$" --format "{{.ID}}"
$hrmExists = [bool]$hrmId
if ($hrmExists) {
  $hrmInspectionRows = @(& docker container inspect $hrmContainer | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0 -or $hrmInspectionRows.Count -ne 1) { throw "Could not inspect the HR Manager container." }
  $hrmInspection = $hrmInspectionRows[0]
  $hrmLabels = $hrmInspection.Config.Labels
  $hrmManagedKind = [string]$hrmLabels.'one-man-company.managed-kind'
  $hrmSocketMount = Test-ExpectedBindMount $hrmInspection "/var/run/docker.sock" "/var/run/docker.sock" $false
  $legacyManagedHrm = $hrmManagedKind -eq "" -and [string]$hrmLabels.'one-man-company.employee' -eq $hrm.id -and
    [string]$hrmLabels.'one-man-company.docker-socket-holder' -eq "true" -and $hrmSocketMount
  if ($hrmManagedKind -ne "hrm" -and -not $legacyManagedHrm) {
    throw "Refusing to replace $hrmContainer because the name is occupied by an unrelated container."
  }
  $existingVersion = [string]$hrmLabels.'one-man-company.runtime-version'
  $existingAuthVersion = [string]$hrmLabels.'one-man-company.auth-version'
  $existingGithubAuthVersion = [string]$hrmLabels.'one-man-company.github-auth-version'
  $existingBaseImageIdentity = [string]$hrmLabels.'one-man-company.base-image-id'
  $existingHrmImageIdentity = [string]$hrmLabels.'one-man-company.hrm-image-id'
  $actualHrmImageIdentity = [string]$hrmInspection.Image
  $authMarkerDirectory = [IO.Path]::GetFullPath((Join-Path $hrmWorkspace ".company"))
  $authMarkerPath = [IO.Path]::GetFullPath((Join-Path $authMarkerDirectory "auth-version"))
  if (-not $authMarkerPath.StartsWith($hrmWorkspace, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe authentication marker path." }
  if (-not (Test-Path -LiteralPath $authMarkerPath -PathType Leaf) -and $existingAuthVersion -match '^[0-9a-f]{64}$') {
    New-Item -ItemType Directory -Force -Path $authMarkerDirectory | Out-Null
    [IO.File]::WriteAllText($authMarkerPath, "$existingAuthVersion`n", $utf8NoBom)
  }
  if ($BuildImage -or $existingVersion -ne $runtimeVersion -or $existingAuthVersion -ne $authVersion -or
      $existingGithubAuthVersion -ne $githubAuthVersion -or $existingHrmImageIdentity -ne $hrmImageIdentity -or
      $existingBaseImageIdentity -ne $baseImageIdentity -or $actualHrmImageIdentity -ne $hrmImageIdentity -or
      [string]$hrmLabels.'one-man-company.employee' -ne $hrm.id -or
      [string]$hrmLabels.'one-man-company.docker-socket-holder' -ne "true" -or -not $hrmSocketMount) {
    & docker container rm --force $hrmContainer | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "The obsolete HR Manager container could not be replaced." }
    $hrmExists = $false
  }
}
if ($hrm.desiredRuntimeStatus -eq "running" -and -not $hrmExists) {
  $createArgs = @(
    "create", "--name", $hrmContainer,
    "--label", "one-man-company.employee=$($hrm.id)",
    "--label", "one-man-company.managed-kind=hrm",
    "--label", "one-man-company.docker-socket-holder=true",
    "--label", "one-man-company.runtime-version=$runtimeVersion",
    "--label", "one-man-company.auth-version=$authVersion",
    "--label", "one-man-company.github-auth-version=$githubAuthVersion",
    "--label", "one-man-company.base-image-id=$baseImageIdentity",
    "--label", "one-man-company.hrm-image-id=$hrmImageIdentity",
    "--restart", "unless-stopped",
    "--network", $companyNetwork,
    "--group-add", "0",
    "--add-host", "host.docker.internal:host-gateway",
    "--env", "OMC_EMPLOYEE_ID=$($hrm.id)",
    "--env", "OMC_WORKER_ID=$hrmContainer",
    "--env", "OMC_CONTROL_URL=$insideControlUrl",
    "--env", "OMC_BASE_IMAGE=$baseImage",
    "--env", "OMC_BASE_IMAGE_ID=$baseImageIdentity",
    "--env", "OMC_AUTH_VERSION=$authVersion",
    "--env", "OMC_GITHUB_AUTH_VERSION=$githubAuthVersion",
    "--env", "OMC_DOCKER_NETWORK=$companyNetwork",
    "--env", "OMC_TRAINING_ROOT=/company/training-cache",
    "--env", "OMC_STATE_ROOT=/company/state",
    "--volume", "$authPath`:/run/secrets/codex_auth:ro",
    "--volume", "$skillCacheRoot`:/company/training-cache:ro",
    "--volume", "$stateRoot`:/company/state:ro",
    "--volume", "$hrmWorkspace`:/workspace",
    "--volume", "/var/run/docker.sock:/var/run/docker.sock"
  )
  if ($BridgeToken) { $createArgs += @("--env", "OMC_RUNTIME_BRIDGE_TOKEN=$BridgeToken") }
  $createArgs += $hrmImageIdentity
  & docker @createArgs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The HR Manager container could not be created." }
  $createdHrmRows = @(& docker container inspect $hrmContainer | ConvertFrom-Json)
  $createdHrmLabels = if ($createdHrmRows.Count -eq 1) { $createdHrmRows[0].Config.Labels } else { $null }
  if ($LASTEXITCODE -ne 0 -or $createdHrmRows.Count -ne 1 -or
      [string]$createdHrmRows[0].Image -ne $hrmImageIdentity -or
      [string]$createdHrmLabels.'one-man-company.managed-kind' -ne "hrm" -or
      [string]$createdHrmLabels.'one-man-company.employee' -ne $hrm.id -or
      [string]$createdHrmLabels.'one-man-company.docker-socket-holder' -ne "true" -or
      -not (Test-ExpectedBindMount $createdHrmRows[0] "/var/run/docker.sock" "/var/run/docker.sock" $false)) {
    throw "The HR Manager failed independent image or Docker socket bind verification."
  }
  & docker start $hrmContainer | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The HR Manager container could not be started." }
  $hrmExists = $true
} elseif ($hrm.desiredRuntimeStatus -eq "running" -and $hrmExists) {
  $current = (& docker container inspect --format "{{.State.Status}}" $hrmContainer).Trim()
  if ($current -eq "exited" -or $current -eq "created") { & docker start $hrmContainer | Out-Null }
} elseif ($hrm.desiredRuntimeStatus -eq "stopped" -and $hrmExists) {
  $current = (& docker container inspect --format "{{.State.Status}}" $hrmContainer).Trim()
  if ($current -eq "running" -or $current -eq "paused" -or $current -eq "restarting") { & docker stop $hrmContainer | Out-Null }
}

if ($hrmExists) {
  $hrmStatus = (& docker container inspect --format "{{.State.Status}}" $hrmContainer).Trim()
  $identity = (& docker container inspect --format "{{.State.StartedAt}}-{{.State.FinishedAt}}" $hrmContainer).Trim()
  Send-HrmRuntimeEvent $hrmStatus "Docker state observed by the minimal host bootstrap." $identity
} elseif ($hrm.runtimeStatus -ne "not_provisioned") {
  Send-HrmRuntimeEvent "not_found" "The HR Manager container was not found by the host bootstrap." (Get-Date -Format "yyyyMMddHH")
}

Write-Output "HR Manager bootstrap complete; its private reconciliation loop is active."
