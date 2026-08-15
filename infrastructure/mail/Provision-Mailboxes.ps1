[CmdletBinding()]
param(
  [string]$ControlUrl = "http://localhost:3000",
  [string]$BridgeToken = $env:OMC_RUNTIME_BRIDGE_TOKEN
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$secretsPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".env.local"))
$stateRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "runtime\state"))
if (-not $secretsPath.StartsWith([IO.Path]::GetFullPath($PSScriptRoot)) -or -not $stateRoot.StartsWith($repoRoot)) {
  throw "Resolved mailbox paths left the repository boundary."
}
if (-not (Test-Path -LiteralPath $secretsPath -PathType Leaf)) {
  throw "Start Stalwart first with infrastructure/mail/Start-Mail.ps1."
}

$secretLine = Get-Content -LiteralPath $secretsPath | Where-Object { $_ -like "STALWART_RECOVERY_ADMIN=*" } | Select-Object -First 1
$credential = $secretLine.Substring("STALWART_RECOVERY_ADMIN=".Length).Split(":", 2)
if ($credential.Count -ne 2) { throw "The local Stalwart recovery credential is malformed." }
$headers = @{}
if ($BridgeToken) { $headers["x-runtime-bridge-token"] = $BridgeToken }
$workforce = Invoke-RestMethod -Uri "$($ControlUrl.TrimEnd('/'))/api/employees" -Headers $headers -Method Get

$cliBase = @(
  "run", "--rm", "--network", "one-man-company",
  "--env", "STALWART_URL=http://stalwart:8080",
  "--env", "STALWART_USER=$($credential[0])",
  "--env", "STALWART_PASSWORD=$($credential[1])",
  "stalwartlabs/cli:1.0.12"
)
$domainLines = & docker @cliBase query domain --fields id,name --json
if ($LASTEXITCODE -ne 0) { throw "Could not query the Stalwart domain. Complete its setup wizard first." }
$domain = $domainLines | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.name -eq "one-man-company.test" } | Select-Object -First 1
if (-not $domain) { throw "The one-man-company.test domain is not configured in Stalwart." }

$accountLines = & docker @cliBase query account --fields id,name --json
if ($LASTEXITCODE -ne 0) { throw "Could not query Stalwart accounts." }
$accounts = @($accountLines | ForEach-Object { $_ | ConvertFrom-Json })

foreach ($employee in $workforce.employees) {
  if (-not $employee.emailAddress) { continue }
  $localPart = ([string]$employee.emailAddress).Split("@")[0]
  $existing = $accounts | Where-Object { $_.name -eq $localPart } | Select-Object -First 1
  $employeeRoot = [IO.Path]::GetFullPath((Join-Path $stateRoot $employee.id))
  $passwordPath = [IO.Path]::GetFullPath((Join-Path $employeeRoot "mail-password"))
  if (-not $employeeRoot.StartsWith($stateRoot) -or -not $passwordPath.StartsWith($employeeRoot)) { throw "Unsafe mailbox secret path." }
  New-Item -ItemType Directory -Force -Path $employeeRoot | Out-Null

  if (-not $existing) {
    if (Test-Path -LiteralPath $passwordPath -PathType Leaf) {
      $mailPassword = Get-Content -LiteralPath $passwordPath -Raw
    }
    if (-not $mailPassword -or $mailPassword -cnotmatch "[A-Z]" -or $mailPassword -cnotmatch "[a-z]" -or $mailPassword -notmatch "[0-9]" -or $mailPassword -notmatch "[^A-Za-z0-9]") {
      $passwordBytes = [byte[]]::new(24)
      $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
      $generator.GetBytes($passwordBytes)
      $generator.Dispose()
      $mailPassword = "Aa1!" + [Convert]::ToBase64String($passwordBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
      Set-Content -LiteralPath $passwordPath -Value $mailPassword -Encoding Ascii -NoNewline
    }
    $accountJson = @{
      name = $localPart
      description = "$($employee.name) · $($employee.role)"
      domainId = $domain.id
      aliases = @{}
      credentials = @{ "0" = @{ "@type" = "Password"; secret = $mailPassword } }
      encryptionAtRest = @{ "@type" = "Disabled" }
      memberGroupIds = @{}
      permissions = @{ "@type" = "Inherit" }
      quotas = @{}
      roles = @{ "@type" = "User" }
    } | ConvertTo-Json -Compress -Depth 5
    $accountPath = [IO.Path]::GetFullPath((Join-Path $employeeRoot "mail-account.json"))
    if (-not $accountPath.StartsWith($employeeRoot)) { throw "Unsafe temporary account path." }
    [IO.File]::WriteAllText($accountPath, $accountJson, [Text.UTF8Encoding]::new($false))
    $accountCli = @(
      "run", "--rm", "--network", "one-man-company",
      "--mount", "type=bind,source=$employeeRoot,target=/work",
      "--env", "STALWART_URL=http://stalwart:8080",
      "--env", "STALWART_USER=$($credential[0])",
      "--env", "STALWART_PASSWORD=$($credential[1])",
      "stalwartlabs/cli:1.0.12"
    )
    & docker @accountCli create account/user --file /work/mail-account.json | Out-Null
    $creationExitCode = $LASTEXITCODE
    Remove-Item -LiteralPath $accountPath -Force
    if ($creationExitCode -ne 0) {
      $failure = @{ action = "reportMailbox"; employeeId = $employee.id; status = "failed" } | ConvertTo-Json -Compress
      Invoke-RestMethod -Uri "$($ControlUrl.TrimEnd('/'))/api/mail" -Headers $headers -Method Post -ContentType "application/json" -Body $failure | Out-Null
      throw "Mailbox creation failed for $($employee.name)."
    }
  }

  $ready = @{ action = "reportMailbox"; employeeId = $employee.id; status = "ready" } | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri "$($ControlUrl.TrimEnd('/'))/api/mail" -Headers $headers -Method Post -ContentType "application/json" -Body $ready | Out-Null
}

Write-Output "Mailbox reconciliation complete. Credentials remain under runtime/state and are never returned to the portal."
