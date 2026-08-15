[CmdletBinding()]
param(
  [switch]$SkipCompanyRefresh
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$credentialDirectory = [IO.Path]::GetFullPath((Join-Path $repoRoot "assets\github_auth"))
$credentialPath = [IO.Path]::GetFullPath((Join-Path $credentialDirectory "token"))
$credentialRelativePath = "assets/github_auth/token"

if (-not $credentialPath.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Resolved GitHub credential path left the repository boundary."
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git is required to import the existing VincentL01 credential."
}

& git -C $repoRoot check-ignore --quiet -- $credentialRelativePath
if ($LASTEXITCODE -ne 0) {
  throw "Refusing to import the GitHub credential because assets/github_auth/token is not ignored by Git."
}

$startInfo = New-Object Diagnostics.ProcessStartInfo
$startInfo.FileName = "git"
$startInfo.Arguments = "credential fill"
$startInfo.WorkingDirectory = $repoRoot
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$process = New-Object Diagnostics.Process
$process.StartInfo = $startInfo
if (-not $process.Start()) { throw "Git Credential Manager could not be started." }
$process.StandardInput.WriteLine("protocol=https")
$process.StandardInput.WriteLine("host=github.com")
$process.StandardInput.WriteLine("")
$process.StandardInput.Close()
$credentialOutput = $process.StandardOutput.ReadToEnd()
$process.StandardError.ReadToEnd() | Out-Null
$process.WaitForExit()
if ($process.ExitCode -ne 0) { throw "Git Credential Manager did not return a GitHub credential." }

$fields = @{}
foreach ($line in ($credentialOutput -split "`r?`n")) {
  $separator = $line.IndexOf('=')
  if ($separator -gt 0) { $fields[$line.Substring(0, $separator)] = $line.Substring($separator + 1) }
}
$username = [string]$fields["username"]
$password = [string]$fields["password"]
if ($username -ne "VincentL01" -or $password.Length -lt 20) {
  throw "The stored github.com credential is not the approved VincentL01 identity."
}

New-Item -ItemType Directory -Force -Path $credentialDirectory | Out-Null
[IO.File]::WriteAllText($credentialPath, $password, (New-Object Text.UTF8Encoding($false)))
$credentialOutput = $null
$password = $null

if (-not $SkipCompanyRefresh) {
  & (Join-Path $PSScriptRoot "Start-Company.ps1")
}

Write-Output "The VincentL01 GitHub credential was securely imported for Project Manager containers."
