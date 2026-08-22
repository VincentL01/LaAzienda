function Get-LaAziendaRepositoryRelativePath {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string]$CandidatePath
  )

  $fullRoot = [IO.Path]::GetFullPath($RepositoryRoot)
  $fullPath = [IO.Path]::GetFullPath($CandidatePath)
  $separators = [char[]]@(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $rootPrefix = $fullRoot.TrimEnd($separators) + [IO.Path]::DirectorySeparatorChar
  $comparison = if ([IO.Path]::DirectorySeparatorChar -eq [char]"\") {
    [StringComparison]::OrdinalIgnoreCase
  } else {
    [StringComparison]::Ordinal
  }

  if (-not $fullPath.StartsWith($rootPrefix, $comparison)) {
    throw "Resolved path left the repository boundary."
  }

  return $fullPath.Substring($rootPrefix.Length).Replace(
    [IO.Path]::DirectorySeparatorChar,
    [char]"/"
  )
}
