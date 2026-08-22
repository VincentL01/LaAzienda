[CmdletBinding()]
param(
  [ValidateSet("all", "blocked", "unreadable", "empty")]
  [string]$ScenarioOnly = "all"
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$suffix = [Guid]::NewGuid().ToString("N").Substring(0, 12)
$runLabel = "one-man-company.integration-run=$suffix"
$baseImage = "omc-test-live-bootstrap-base:$suffix"
$hrmImage = "omc-test-live-bootstrap-hrm:$suffix"
$network = "omc-test-live-bootstrap-$suffix"
$authSource = "omc-test-auth-source-$suffix"
$authVolume = "omc-test-auth-$suffix"
$bridgeToken = "omc-test-bridge-$suffix"
$fixturePath = Join-Path $repoRoot "tests\fixtures\hrm-live-bootstrap-control-plane.mjs"
$workspaceSeedPath = Join-Path $repoRoot "tests\fixtures\hrm-live-bootstrap-seed-workspace.sh"
$probePath = Join-Path $repoRoot "tests\fixtures\hrm-live-bootstrap-probe.sh"
$partialPublicationPath = Join-Path $repoRoot "tests\fixtures\hrm-live-bootstrap-partial-publication.sh"
$appliedEvidencePath = Join-Path $repoRoot "tests\fixtures\hrm-live-bootstrap-applied-evidence.sh"
$createdContainers = [Collections.Generic.List[object]]::new()
$createdVolumes = [Collections.Generic.List[string]]::new()
$createdImages = [Collections.Generic.List[string]]::new()
$networkCreated = $false

if ($suffix -notmatch '^[a-f0-9]{12}$' -or
    $baseImage -notmatch '^omc-test-live-bootstrap-base:[a-f0-9]{12}$' -or
    $hrmImage -notmatch '^omc-test-live-bootstrap-hrm:[a-f0-9]{12}$' -or
    $network -notmatch '^omc-test-live-bootstrap-[a-f0-9]{12}$' -or
    $authSource -notmatch '^omc-test-auth-source-[a-f0-9]{12}$' -or
    $authVolume -notmatch '^omc-test-auth-[a-f0-9]{12}$') {
  throw "Refusing unsafe disposable Docker artifact names."
}

function Invoke-Docker([string[]]$Arguments) {
  & docker @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Docker command failed: docker $($Arguments -join ' ')" }
}

function Invoke-DockerText([string[]]$Arguments) {
  $output = @(& docker @Arguments)
  if ($LASTEXITCODE -ne 0) { throw "Docker command failed: docker $($Arguments -join ' ')" }
  return ($output -join "`n").Trim()
}

function Get-DockerStatus([string[]]$Arguments, [switch]$Quiet) {
  $priorPreference = $ErrorActionPreference
  $status = 1
  try {
    $ErrorActionPreference = "Continue"
    if ($Quiet) { & docker @Arguments *> $null } else { & docker @Arguments | Out-Host }
    $status = [int]$LASTEXITCODE
  } catch {
    if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { $status = [int]$LASTEXITCODE }
  } finally {
    $ErrorActionPreference = $priorPreference
  }
  return $status
}

function Test-DockerObject([string[]]$Arguments) {
  return (Get-DockerStatus -Arguments $Arguments -Quiet) -eq 0
}

function New-TestVolume([string]$Name) {
  if ($Name -notmatch '^omc-(?:test-[a-z0-9-]+|(?:workspace|skills|installed-skills|secrets)-employee-aurora-(?:blocked|unreadable|empty)-[a-f0-9]{12})$') {
    throw "Refusing unsafe disposable volume name: $Name"
  }
  $createdVolumes.Add($Name)
  Invoke-Docker @("volume", "create", "--label", $runLabel, $Name) | Out-Null
}

function Add-TestContainer([string]$Name, [string]$IdentityLabel, [string]$IdentityValue) {
  $createdContainers.Add([pscustomobject]@{ Name = $Name; Label = $IdentityLabel; Value = $IdentityValue })
}

function Wait-ControlPlane([string]$Name) {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
  do {
    $status = Get-DockerStatus -Arguments @("exec", $Name, "node", "-e", "fetch('http://127.0.0.1:8080/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))") -Quiet
    if ($status -eq 0) { return }
    Start-Sleep -Milliseconds 200
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Disposable control plane $Name did not become ready."
}

function Assert-AuthorityManifest([string]$SkillsVolume, [string]$EmployeeId, [string]$FileName) {
  $manifest = Invoke-DockerText @(
    "run", "--rm", "--entrypoint", "cat",
    "--volume", "${SkillsVolume}:/source:ro", $baseImage, "/source/$FileName"
  )
  if ([Text.Encoding]::UTF8.GetByteCount($manifest) -le 0) { throw "$FileName remained empty." }
  try { $parsed = $manifest | ConvertFrom-Json -ErrorAction Stop } catch { throw "$FileName is not valid JSON." }
  if ($parsed.schemaVersion -ne 2 -or $parsed.employeeId -cne $EmployeeId -or
      $parsed.manifestVersion -notmatch '^[a-f0-9]{64}$' -or
      @($parsed.skills).Count -ne 0 -or @($parsed.removals).Count -ne 0) {
    throw "$FileName does not contain the expected empty installed-volume authority contract."
  }
}

function Test-PartialAuthorityPublication() {
  $employeeId = "employee-aurora-publication-$suffix"
  $containerName = "omc-test-publication-$suffix"
  $controlVolume = "omc-test-publication-control-$suffix"
  $installedVolume = "omc-test-publication-installed-$suffix"
  if ($employeeId -notmatch '^employee-aurora-publication-[a-f0-9]{12}$' -or
      $containerName -notmatch '^omc-test-publication-[a-f0-9]{12}$') {
    throw "Refusing unsafe partial-publication test identity."
  }
  New-TestVolume $controlVolume
  New-TestVolume $installedVolume
  Add-TestContainer $containerName "one-man-company.integration-run" $suffix
  $baseImageId = Invoke-DockerText @("image", "inspect", "--format", "{{.Id}}", $baseImage)
  $status = Get-DockerStatus -Arguments @(
    "run", "--name", $containerName, "--label", $runLabel, "--group-add", "0",
    "--volume", "/var/run/docker.sock:/var/run/docker.sock",
    "--volume", "${partialPublicationPath}:/fixture/partial-publication.sh:ro",
    "--env", "OMC_BASE_IMAGE_ID=$baseImageId",
    "--env", "OMC_AUTH_SOURCE_CONTAINER=$authSource",
    "--entrypoint", "bash", $hrmImage, "/fixture/partial-publication.sh", $employeeId, $controlVolume, $installedVolume
  )
  if ($status -ne 0) { throw "The partial authority publication contract failed with status $status." }
}

function Test-AppliedEvidenceContract() {
  $employeeId = "employee-aurora-evidence-$suffix"
  $containerName = "omc-test-applied-evidence-$suffix"
  if ($employeeId -notmatch '^employee-aurora-evidence-[a-f0-9]{12}$' -or
      $containerName -notmatch '^omc-test-applied-evidence-[a-f0-9]{12}$') {
    throw "Refusing unsafe applied-evidence test identity."
  }
  Add-TestContainer $containerName "one-man-company.integration-run" $suffix
  $baseImageId = Invoke-DockerText @("image", "inspect", "--format", "{{.Id}}", $baseImage)
  $status = Get-DockerStatus -Arguments @(
    "run", "--name", $containerName, "--label", $runLabel, "--group-add", "0",
    "--volume", "/var/run/docker.sock:/var/run/docker.sock",
    "--volume", "${appliedEvidencePath}:/fixture/applied-evidence.sh:ro",
    "--env", "OMC_BASE_IMAGE_ID=$baseImageId",
    "--env", "OMC_AUTH_SOURCE_CONTAINER=$authSource",
    "--entrypoint", "bash", $hrmImage, "/fixture/applied-evidence.sh", $employeeId
  )
  if ($status -ne 0) { throw "The applied-evidence production contract failed with status $status." }
}

function Get-VolumeFileByteCount([string]$Volume, [string]$FileName) {
  $count = Invoke-DockerText @(
    "run", "--rm", "--user", "0", "--entrypoint", "stat", "--volume", "${Volume}:/source:ro",
    $baseImage, "--format=%s", "/source/$FileName"
  )
  if ($count -notmatch '^\d+$') { throw "Could not measure $FileName in $Volume." }
  return [int64]$count
}

function Invoke-BootstrapCase([ValidateSet("blocked", "unreadable", "empty")][string]$Scenario) {
  $employeeId = "employee-aurora-$Scenario-$suffix"
  $employeeContainer = "omc-test-aurora-$Scenario-$suffix"
  $mockContainer = "omc-test-control-$Scenario-$suffix"
  $hrmContainer = "omc-test-hrm-$Scenario-$suffix"
  $workspaceVolume = "omc-workspace-$employeeId"
  $skillsVolume = "omc-skills-$employeeId"
  $installedVolume = "omc-installed-skills-$employeeId"
  $secretsVolume = "omc-secrets-$employeeId"
  $hrmWorkspace = "omc-test-hrm-workspace-$Scenario-$suffix"
  $trainingVolume = "omc-test-training-$Scenario-$suffix"
  $stateVolume = "omc-test-state-$Scenario-$suffix"

  foreach ($name in @($employeeContainer, $mockContainer, $hrmContainer)) {
    if ($name -notmatch '^omc-test-[a-z]+-(?:blocked|unreadable|empty)-[a-f0-9]{12}$') {
      throw "Refusing unsafe disposable container name: $name"
    }
  }
  if ($employeeId -notmatch '^employee-aurora-(?:blocked|unreadable|empty)-[a-f0-9]{12}$') {
    throw "Refusing unsafe disposable employee identity."
  }
  Add-TestContainer $employeeContainer "one-man-company.employee" $employeeId

  foreach ($volume in @($workspaceVolume, $skillsVolume, $installedVolume, $secretsVolume, $hrmWorkspace, $trainingVolume, $stateVolume)) {
    New-TestVolume $volume
  }

  Invoke-Docker @(
    "run", "--rm", "--user", "0", "--entrypoint", "bash",
    "--volume", "${workspaceVolume}:/workspace",
    "--volume", "${workspaceSeedPath}:/fixture/seed-workspace.sh:ro",
    $baseImage, "/fixture/seed-workspace.sh", $employeeId
  ) | Out-Null

  $zeroAuthorities = @'
set -eu
: > /control/.omc-training-managed.json
: > /control/.omc-training-managed.last-good.json
chown 1001:1001 /control/.omc-training-managed.json /control/.omc-training-managed.last-good.json
'@
  Add-TestContainer $mockContainer "one-man-company.integration-run" $suffix
  Invoke-Docker @(
    "run", "--rm", "--user", "0", "--entrypoint", "sh",
    "--volume", "${skillsVolume}:/control", $baseImage, "-c", $zeroAuthorities
  ) | Out-Null

  if ($Scenario -eq "blocked") {
    $seedInstalled = @'
set -eu
mkdir -p /installed/untrusted
printf '%s\n' 'must remain fail closed' > /installed/untrusted/SKILL.md
chown -R 1001:1001 /installed
'@
    Invoke-Docker @(
      "run", "--rm", "--user", "0", "--entrypoint", "sh",
      "--volume", "${installedVolume}:/installed", $baseImage, "-c", $seedInstalled
    ) | Out-Null
  } elseif ($Scenario -eq "unreadable") {
    Invoke-Docker @(
      "run", "--rm", "--user", "0", "--entrypoint", "chmod",
      "--volume", "${installedVolume}:/installed", $baseImage, "000", "/installed"
    ) | Out-Null
    $enumerationStatus = Get-DockerStatus -Arguments @(
      "run", "--rm", "--user", "1001:1001",
      "--volume", "${workspaceVolume}:/workspace:ro",
      "--volume", "${installedVolume}:/workspace/.agents/skills:ro",
      "--entrypoint", "/usr/local/bin/sync-company-skills", $baseImage, "--list-workspace-folders"
    ) -Quiet
    if ($enumerationStatus -eq 0) { throw "The unreadable installed-skills root did not produce an enumeration error." }
  }

  Invoke-Docker @(
    "run", "--detach", "--name", $mockContainer, "--label", $runLabel,
    "--network", $network,
    "--env", "OMC_TEST_EMPLOYEE_ID=$employeeId",
    "--env", "OMC_TEST_EMPLOYEE_CONTAINER=$employeeContainer",
    "--env", "OMC_TEST_BRIDGE_TOKEN=$bridgeToken",
    "--volume", "${fixturePath}:/fixture/control-plane.mjs:ro",
    "--entrypoint", "node", $baseImage, "/fixture/control-plane.mjs"
  ) | Out-Null
  Wait-ControlPlane $mockContainer

  $baseImageId = Invoke-DockerText @("image", "inspect", "--format", "{{.Id}}", $baseImage)
  if ($baseImageId -notmatch '^sha256:[a-f0-9]{64}$') { throw "The disposable base image did not resolve to an immutable id." }

  $hrmArguments = @(
    "run", "--name", $hrmContainer, "--label", $runLabel,
    "--network", $network,
    "--group-add", "0",
    "--volume", "/var/run/docker.sock:/var/run/docker.sock",
    "--volume", "${authVolume}:/run/secrets:ro",
    "--volume", "${hrmWorkspace}:/workspace",
    "--volume", "${trainingVolume}:/company/training-cache:ro",
    "--volume", "${stateVolume}:/company/state:ro",
    "--env", "OMC_EMPLOYEE_ID=employee-hrm",
    "--env", "OMC_WORKER_ID=omc-test-hrm-$suffix",
    "--env", "OMC_CONTROL_URL=http://${mockContainer}:8080",
    "--env", "OMC_RUNTIME_BRIDGE_TOKEN=$bridgeToken",
    "--env", "OMC_BASE_IMAGE=$baseImage",
    "--env", "OMC_BASE_IMAGE_ID=$baseImageId",
    "--env", "OMC_DOCKER_NETWORK=$network",
    "--env", "OMC_AUTH_SOURCE_CONTAINER=$authSource",
    "--env", "OMC_INTEGRITY_AUDIT_SECONDS=0",
    "--entrypoint", "/opt/one-man-company/reconcile", $hrmImage
  )
  Add-TestContainer $hrmContainer "one-man-company.integration-run" $suffix
  $reconcileExit = Get-DockerStatus -Arguments $hrmArguments

  if ($Scenario -ne "empty") {
    if ($reconcileExit -ne 75) { throw "Unsafe $Scenario bootstrap exited $reconcileExit instead of 75." }
    if (Test-DockerObject @("container", "inspect", $employeeContainer)) { throw "The fail-closed case created an employee container." }
    if ($Scenario -eq "blocked") {
      $stillInstalled = Invoke-DockerText @(
        "run", "--rm", "--user", "0", "--entrypoint", "cat", "--volume", "${installedVolume}:/source:ro",
        $baseImage, "/source/untrusted/SKILL.md"
      )
      if ($stillInstalled -cne "must remain fail closed") { throw "The fail-closed case mutated the independently installed content." }
    } else {
      $installedMode = Invoke-DockerText @(
        "run", "--rm", "--user", "0", "--entrypoint", "stat", "--volume", "${installedVolume}:/source:ro",
        $baseImage, "--format=%a", "/source"
      )
      if ($installedMode -cne "0") { throw "The unreadable installed-skills root was unexpectedly changed." }
    }
    foreach ($authority in @(".omc-training-managed.json", ".omc-training-managed.last-good.json")) {
      if ((Get-VolumeFileByteCount $skillsVolume $authority) -ne 0) {
        throw "The fail-closed case rewrote corrupt authority $authority."
      }
    }
    return
  }

  if ($reconcileExit -ne 0) {
    Write-Warning "Empty-volume bootstrap failed; bounded disposable evidence follows."
    & docker logs $mockContainer
    $provenanceProbeStatus = Get-DockerStatus -Arguments @(
      "run", "--rm", "--group-add", "0",
      "--volume", "/var/run/docker.sock:/var/run/docker.sock",
      "--volume", "${probePath}:/fixture/probe.sh:ro",
      "--env", "OMC_BASE_IMAGE_ID=$baseImageId",
      "--env", "OMC_AUTH_SOURCE_CONTAINER=$authSource",
      "--entrypoint", "bash", $hrmImage, "/fixture/probe.sh", $employeeId, $workspaceVolume, $installedVolume, $skillsVolume
    )
    Write-Warning "Read-only provenance probe exited $provenanceProbeStatus."
    & docker run --rm --user 1001:1001 --env "OMC_EMPLOYEE_ID=$employeeId" `
      --volume "${skillsVolume}:/opt/assigned-skills" `
      --volume "${workspaceVolume}:/workspace" `
      --volume "${installedVolume}:/workspace/.agents/skills" `
      --entrypoint /usr/local/bin/sync-company-skills $baseImage --recover
    $recoveryProbeStatus = $LASTEXITCODE
    Write-Warning "Post-failure direct recovery probe exited $recoveryProbeStatus."
    $enumerationProbe = @(& docker run --rm --user 1001:1001 `
      --volume "${workspaceVolume}:/workspace:ro" `
      --volume "${installedVolume}:/workspace/.agents/skills:ro" `
      --entrypoint /usr/local/bin/sync-company-skills $baseImage --list-workspace-folders)
    $enumerationProbeStatus = $LASTEXITCODE
    Write-Warning "Post-failure installed-folder enumeration exited $enumerationProbeStatus with $($enumerationProbe.Count) entries."
    & docker run --rm --user 0 --entrypoint bash `
      --volume "${workspaceVolume}:/evidence/workspace:ro" `
      --volume "${skillsVolume}:/evidence/control:ro" `
      --volume "${installedVolume}:/evidence/installed:ro" $baseImage -c `
      'find /evidence -maxdepth 5 -printf "%M %u:%g %s %p\n" | LC_ALL=C sort'
    throw "Empty-volume bootstrap reconcile exited $reconcileExit."
  }
  $employeeState = Invoke-DockerText @("container", "inspect", "--format", "{{.State.Status}}", $employeeContainer)
  if ($employeeState -cne "running") { throw "The disposable Aurora employee is not running." }
  $companyState = Invoke-DockerText @(
    "run", "--rm", "--user", "1001:1001", "--entrypoint", "bash",
    "--volume", "${workspaceVolume}:/workspace:ro", $baseImage, "-c",
    'set -Eeuo pipefail; [[ -O /workspace/.company && -r /workspace/.company && -x /workspace/.company ]]; [[ -d /workspace/.company/training && -O /workspace/.company/training ]]; stat -c "%u:%g:%a" /workspace/.company'
  )
  if ($companyState -cne "1001:1001:755") { throw "The retained root-owned company directory was not normalized for UID 1001." }
  $employeeLabel = Invoke-DockerText @("container", "inspect", "--format", '{{index .Config.Labels "one-man-company.employee"}}', $employeeContainer)
  if ($employeeLabel -cne $employeeId) { throw "The disposable Aurora employee label is incorrect." }
  $installedMount = Invoke-DockerText @(
    "container", "inspect", "--format",
    "{{range .Mounts}}{{if eq .Destination `"/workspace/.agents/skills`"}}{{.Name}}|{{.RW}}{{end}}{{end}}",
    $employeeContainer
  )
  if ($installedMount -cne "$installedVolume|false") { throw "The installed-skills volume is not mounted read-only on the employee." }
  Assert-AuthorityManifest $skillsVolume $employeeId ".omc-training-managed.json"
  Assert-AuthorityManifest $skillsVolume $employeeId ".omc-training-managed.last-good.json"
}

try {
  if (-not (Test-Path -LiteralPath $fixturePath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $workspaceSeedPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $probePath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $partialPublicationPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $appliedEvidencePath -PathType Leaf)) {
    throw "A disposable live-bootstrap fixture is missing."
  }
  Invoke-Docker @("build", "--tag", $baseImage, (Join-Path $repoRoot "runtime\agent")) | Out-Null
  $createdImages.Add($baseImage)
  Invoke-Docker @("build", "--build-arg", "BASE_IMAGE=$baseImage", "--tag", $hrmImage, (Join-Path $repoRoot "runtime\hrm")) | Out-Null
  $createdImages.Add($hrmImage)
  $networkCreated = $true
  Invoke-Docker @("network", "create", "--label", $runLabel, $network) | Out-Null
  New-TestVolume $authVolume

  $seedAuth = @'
set -eu
printf '%s\n' '{"auth_mode":"test"}' > /secrets/codex_auth
chmod 0400 /secrets/codex_auth
chown 1001:1001 /secrets/codex_auth
'@
  Add-TestContainer $authSource "one-man-company.integration-run" $suffix
  Invoke-Docker @(
    "run", "--rm", "--user", "0", "--entrypoint", "sh",
    "--volume", "${authVolume}:/secrets", $baseImage, "-c", $seedAuth
  ) | Out-Null
  Invoke-Docker @(
    "create", "--name", $authSource, "--label", $runLabel,
    "--volume", "${authVolume}:/run/secrets:ro", "--entrypoint", "sleep", $baseImage, "infinity"
  ) | Out-Null

  Test-PartialAuthorityPublication
  Test-AppliedEvidenceContract
  $scenarios = if ($ScenarioOnly -eq "all") { @("blocked", "unreadable", "empty") } else { @($ScenarioOnly) }
  foreach ($scenario in $scenarios) { Invoke-BootstrapCase $scenario }
  if ($ScenarioOnly -eq "all") {
    Write-Output "PASS: all three live HRM cases fail closed on nonempty or unreadable installed state and repair zero-byte authority only for an independently proven empty Aurora profile."
  } else {
    Write-Output "PASS: live HRM scenario completed: $ScenarioOnly."
  }
}
finally {
  $cleanupFailures = [Collections.Generic.List[string]]::new()
  $containersToRemove = @($createdContainers.ToArray())
  [array]::Reverse($containersToRemove)
  foreach ($artifact in $containersToRemove) {
    if (-not (Test-DockerObject @("container", "inspect", $artifact.Name))) { continue }
    $actual = (& docker container inspect --format "{{index .Config.Labels `"$($artifact.Label)`"}}" $artifact.Name).Trim()
    if ($LASTEXITCODE -ne 0 -or $actual -cne $artifact.Value) {
      $cleanupFailures.Add("refused unverified container $($artifact.Name)")
      continue
    }
    & docker container rm --force $artifact.Name *> $null
    if ($LASTEXITCODE -ne 0) { $cleanupFailures.Add("container $($artifact.Name)") }
  }
  $volumesToRemove = @($createdVolumes.ToArray())
  [array]::Reverse($volumesToRemove)
  foreach ($volume in $volumesToRemove) {
    if (-not (Test-DockerObject @("volume", "inspect", $volume))) { continue }
    $actual = (& docker volume inspect --format "{{index .Labels `"one-man-company.integration-run`"}}" $volume).Trim()
    if ($LASTEXITCODE -ne 0 -or $actual -cne $suffix) {
      $cleanupFailures.Add("refused unverified volume $volume")
      continue
    }
    & docker volume rm $volume *> $null
    if ($LASTEXITCODE -ne 0) { $cleanupFailures.Add("volume $volume") }
  }
  if ($networkCreated) {
    $actual = (& docker network inspect --format "{{index .Labels `"one-man-company.integration-run`"}}" $network).Trim()
    if ($LASTEXITCODE -ne 0 -or $actual -cne $suffix) {
      $cleanupFailures.Add("refused unverified network $network")
    } else {
      & docker network rm $network *> $null
      if ($LASTEXITCODE -ne 0) { $cleanupFailures.Add("network $network") }
    }
  }
  $imagesToRemove = @($createdImages.ToArray())
  [array]::Reverse($imagesToRemove)
  foreach ($image in $imagesToRemove) {
    if ($image -notmatch '^omc-test-live-bootstrap-(?:base|hrm):[a-f0-9]{12}$') {
      $cleanupFailures.Add("refused unverified image $image")
      continue
    }
    & docker image rm $image *> $null
    if ($LASTEXITCODE -ne 0) { $cleanupFailures.Add("image $image") }
  }
  if ($cleanupFailures.Count -gt 0) { throw "Disposable Docker cleanup failed: $($cleanupFailures -join ', ')." }

  foreach ($artifact in $createdContainers) {
    if (Test-DockerObject @("container", "inspect", $artifact.Name)) { throw "Container cleanup verification failed: $($artifact.Name)" }
  }
  foreach ($volume in $createdVolumes) {
    if (Test-DockerObject @("volume", "inspect", $volume)) { throw "Volume cleanup verification failed: $volume" }
  }
  if ($networkCreated) {
    if (Test-DockerObject @("network", "inspect", $network)) { throw "Network cleanup verification failed: $network" }
  }
  foreach ($image in $createdImages) {
    if (Test-DockerObject @("image", "inspect", $image)) { throw "Image cleanup verification failed: $image" }
  }
  Write-Output "PASS: all disposable live-bootstrap Docker artifacts were removed."
}
