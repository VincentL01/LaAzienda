[CmdletBinding()]
param([Parameter(Mandatory)][string]$PackageRef)

$ErrorActionPreference = "Stop"
if ($PackageRef -notmatch "^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+(?:@[a-zA-Z0-9_.-]+)?$") {
  throw "Use a package reference like owner/repository@skill-name."
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$cacheRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "cache"))
if (-not $cacheRoot.StartsWith($repoRoot)) { throw "Cache path left the repository boundary." }

New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
Push-Location $cacheRoot
try {
  & npx --yes skills add $PackageRef -y
  if ($LASTEXITCODE -ne 0) { throw "Skill import failed." }
} finally {
  Pop-Location
}

Write-Output "Imported into training-center/cache. Inspect the resulting SKILL.md before confirming it in the UI."
