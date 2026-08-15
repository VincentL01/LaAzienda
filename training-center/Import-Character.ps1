[CmdletBinding()]
param([Parameter(Mandatory)][string]$Slug)

$ErrorActionPreference = "Stop"
if ($Slug -notmatch "^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$") { throw "Invalid Codex Pets slug." }

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$stagingHome = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "work\codex-home"))
$source = [IO.Path]::GetFullPath((Join-Path $stagingHome "pets\$Slug"))
$assetTarget = [IO.Path]::GetFullPath((Join-Path $repoRoot "assets\characters\$Slug"))
$publicTarget = [IO.Path]::GetFullPath((Join-Path $repoRoot "public\characters\$Slug"))
foreach ($path in @($stagingHome, $source, $assetTarget, $publicTarget)) {
  if (-not $path.StartsWith($repoRoot)) { throw "Character path left the repository boundary." }
}

New-Item -ItemType Directory -Force -Path $stagingHome | Out-Null
$previousCodexHome = $env:CODEX_HOME
$env:CODEX_HOME = $stagingHome
try {
  & npx --yes @astandrik/codex-pets install $Slug
  if ($LASTEXITCODE -ne 0) { throw "Character download failed." }
} finally {
  $env:CODEX_HOME = $previousCodexHome
}

if (-not (Test-Path -LiteralPath (Join-Path $source "pet.json")) -or -not (Test-Path -LiteralPath (Join-Path $source "spritesheet.webp"))) {
  throw "The downloaded pack is incomplete."
}
New-Item -ItemType Directory -Force -Path $assetTarget, $publicTarget | Out-Null
Copy-Item -LiteralPath (Join-Path $source "pet.json") -Destination $assetTarget -Force
Copy-Item -LiteralPath (Join-Path $source "spritesheet.webp") -Destination $assetTarget -Force
Copy-Item -LiteralPath (Join-Path $source "pet.json") -Destination $publicTarget -Force
Copy-Item -LiteralPath (Join-Path $source "spritesheet.webp") -Destination $publicTarget -Force
Write-Output "Copied the original manifest and spritesheet without recompression. Confirm the pack in the Training Center UI."
