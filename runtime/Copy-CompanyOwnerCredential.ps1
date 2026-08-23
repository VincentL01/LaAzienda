[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$pathSafetyPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "Path-Safety.ps1"))
$assetsRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "assets"))
$ownerRoot = [IO.Path]::GetFullPath((Join-Path $assetsRoot "owner"))
$ownerRuntimeRoot = [IO.Path]::GetFullPath((Join-Path $ownerRoot "runtime"))
$credentialPath = [IO.Path]::GetFullPath((Join-Path $ownerRuntimeRoot "credential"))
$credentialRelativePath = "assets/owner/runtime/credential"
$credentialBytes = $null
$credential = $null

try {
  if (-not (Test-Path -LiteralPath $pathSafetyPath -PathType Leaf)) {
    throw "The repository path-safety helper is unavailable."
  }
  $pathSafetyItem = Get-Item -LiteralPath $pathSafetyPath -Force
  if (($pathSafetyItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing a reparse point for the repository path-safety helper."
  }
  . $pathSafetyPath

  $relativeRoot = Get-LaAziendaRepositoryRelativePath -RepositoryRoot $repoRoot -CandidatePath $ownerRuntimeRoot
  $relativeCredential = Get-LaAziendaRepositoryRelativePath -RepositoryRoot $repoRoot -CandidatePath $credentialPath
  if ($relativeRoot -cne "assets/owner/runtime" -or $relativeCredential -cne $credentialRelativePath) {
    throw "Resolved owner credential source is not the expected ignored owner file."
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is required to verify the owner credential boundary."
  }
  & git -C $repoRoot check-ignore --quiet -- $credentialRelativePath
  if ($LASTEXITCODE -ne 0) {
    throw "Refusing to read the owner credential because its path is not ignored by Git."
  }
  if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
    throw "The owner credential is unavailable. Start the company first."
  }
  foreach ($path in @($repoRoot, $assetsRoot, $ownerRoot, $ownerRuntimeRoot, $credentialPath)) {
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing a reparse point in the owner credential source boundary."
    }
  }
  if (-not (Get-Command Set-Clipboard -ErrorAction SilentlyContinue)) {
    throw "Set-Clipboard is required to copy the owner credential."
  }

  $credentialBytes = [IO.File]::ReadAllBytes($credentialPath)
  if ($credentialBytes.Length -lt 43 -or $credentialBytes.Length -gt 128) {
    throw "The owner credential is invalid."
  }
  $credential = [Text.Encoding]::UTF8.GetString($credentialBytes)
  if ($credential -cnotmatch '^[A-Za-z0-9_-]{43,128}$') {
    throw "The owner credential is invalid."
  }
  Set-Clipboard -Value $credential
} finally {
  if ($credentialBytes) { [Array]::Clear($credentialBytes, 0, $credentialBytes.Length) }
  $credential = $null
}

Write-Output "The independent Company Portal owner credential is on the clipboard; successful sessions expire after eight hours."
