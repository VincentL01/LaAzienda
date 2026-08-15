[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$mailRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$secretsPath = [IO.Path]::GetFullPath((Join-Path $mailRoot ".env.local"))
$composePath = [IO.Path]::GetFullPath((Join-Path $mailRoot "compose.yml"))

if (-not $secretsPath.StartsWith($mailRoot) -or -not $composePath.StartsWith($mailRoot)) {
  throw "Resolved mail paths left the infrastructure boundary."
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker CLI is not available."
}

if (-not (Test-Path -LiteralPath $secretsPath -PathType Leaf)) {
  $secretBytes = [byte[]]::new(24)
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  $generator.GetBytes($secretBytes)
  $generator.Dispose()
  $secret = [Convert]::ToBase64String($secretBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
  Set-Content -LiteralPath $secretsPath -Value "STALWART_RECOVERY_ADMIN=admin:$secret" -Encoding Ascii
}

$network = & docker network ls --filter "name=^one-man-company$" --format "{{.Name}}"
if ($network -ne "one-man-company") {
  & docker network create one-man-company | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not create the private company Docker network." }
}

& docker compose --env-file $secretsPath --file $composePath up --detach
if ($LASTEXITCODE -ne 0) { throw "Stalwart could not be started." }

Write-Output "Stalwart is running. Bootstrap administration is machine-local at http://127.0.0.1:8088/admin."
