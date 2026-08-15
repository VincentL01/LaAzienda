[CmdletBinding()]
param([Parameter(Mandatory)][ValidateLength(2, 120)][string]$Query)

$ErrorActionPreference = "Stop"
& npx --yes skills find $Query
if ($LASTEXITCODE -ne 0) { throw "Skill discovery failed." }
