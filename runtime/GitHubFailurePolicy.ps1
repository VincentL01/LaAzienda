function Resolve-GitHubFailureCode {
  [CmdletBinding()]
  param(
    [int]$StatusCode,
    [string]$RetryAfter = "",
    [string]$RateLimitRemaining = "",
    [string]$Detail = "",
    [switch]$VerificationFailure
  )

  if ($VerificationFailure) { return "verification_failed" }
  if ($StatusCode -eq 429) { return "rate_limited" }
  if ($StatusCode -eq 403 -and ($RetryAfter -or $RateLimitRemaining -eq "0" `
    -or $Detail -match '(?i)(secondary\s+rate\s+limit|rate\s+limit|abuse\s+detection)')) {
    return "rate_limited"
  }
  if ($StatusCode -eq 401 -or $StatusCode -eq 403) { return "permission_denied" }
  if ($StatusCode -eq 410) { return "issues_disabled" }
  return "network"
}
