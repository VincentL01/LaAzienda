[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^\d{17,20}$')]
  [string]$ApplicationId,
  [Parameter(Mandatory)]
  [ValidatePattern('^employee-[A-Za-z0-9-]{1,100}$')]
  [string]$EmployeeId,
  [switch]$FromClipboard
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$credentialRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "assets\discord"))
$configPath = [IO.Path]::GetFullPath((Join-Path $credentialRoot "config.json"))
$tokenPath = [IO.Path]::GetFullPath((Join-Path $credentialRoot "bot-token"))

foreach ($path in @($credentialRoot, $configPath, $tokenPath)) {
  if (-not $path.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Resolved Discord credential path left the repository boundary."
  }
}
foreach ($relativePath in @("assets/discord/config.json", "assets/discord/bot-token")) {
  & git -C $repoRoot check-ignore --quiet -- $relativePath
  if ($LASTEXITCODE -ne 0) { throw "Discord credential destinations must remain Git-ignored." }
}

$token = $null
$secureToken = $null
$bstr = [IntPtr]::Zero
try {
  if ($FromClipboard) {
    $token = [string](Get-Clipboard -Raw)
  } else {
    $secureToken = Read-Host "Paste the Aurora bot token" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  }
  $token = $token.Trim()
  if ($token -notmatch '^[A-Za-z0-9._-]{32,200}$') { throw "The copied Discord bot token is invalid." }

  try {
    $application = Invoke-RestMethod -Uri "https://discord.com/api/v10/oauth2/applications/@me" `
      -Headers @{ Authorization = "Bot $token"; "User-Agent" = "LaAzienda-Aurora/0.1" } `
      -Method Get -TimeoutSec 15
  } catch {
    throw "Discord did not accept the copied bot credential."
  }
  if ([string]$application.id -ne $ApplicationId -or [string]$application.owner.id -notmatch '^\d{17,20}$') {
    throw "The copied credential does not belong to the configured CEO-owned application."
  }
  if ([string]$application.name -cne "Aurora") { throw "The Discord application must be named exactly Aurora." }

  New-Item -ItemType Directory -Force -Path $credentialRoot | Out-Null
  $utf8NoBom = [Text.UTF8Encoding]::new($false)
  [IO.File]::WriteAllText($tokenPath, $token, $utf8NoBom)
  $configJson = @{ applicationId = $ApplicationId; employeeId = $EmployeeId } | ConvertTo-Json
  [IO.File]::WriteAllText($configPath, $configJson, $utf8NoBom)
} finally {
  if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  $secureToken = $null
  $token = $null
  $application = $null
  if ($FromClipboard) {
    try { Set-Clipboard -Value "" } catch { }
  }
}

Write-Output "Aurora Discord configuration was imported into ignored local files."
