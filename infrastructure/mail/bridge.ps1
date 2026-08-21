[CmdletBinding()]
param(
  [string]$ControlUrl = "http://localhost:3002",
  [string]$BridgeToken = $env:OMC_RUNTIME_BRIDGE_TOKEN
)

$ErrorActionPreference = "Stop"
$headers = @{}
if ($BridgeToken) { $headers["x-runtime-bridge-token"] = $BridgeToken }
$mailroom = Invoke-RestMethod -Uri "$($ControlUrl.TrimEnd('/'))/api/mail" -Headers $headers -Method Get

function Read-SmtpResponse($reader) {
  $lastLine = ""
  do {
    $lastLine = $reader.ReadLine()
    if ($null -eq $lastLine) { throw "Stalwart closed the SMTP connection unexpectedly." }
  } while ($lastLine.Length -gt 3 -and $lastLine[3] -eq "-")
  if ($lastLine[0] -notin @("2", "3")) { throw "Stalwart rejected the SMTP command: $lastLine" }
}

function Send-StalwartMessage($message) {
  $client = [Net.Sockets.TcpClient]::new("127.0.0.1", 2525)
  try {
    $stream = $client.GetStream()
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $false, 1024, $true)
    $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false), 1024, $true)
    $writer.NewLine = "`r`n"
    $writer.AutoFlush = $true
    Read-SmtpResponse $reader
    $writer.WriteLine("EHLO mail.one-man-company.test")
    Read-SmtpResponse $reader
    $writer.WriteLine("MAIL FROM:<$($message.senderEmail)>")
    Read-SmtpResponse $reader
    $writer.WriteLine("RCPT TO:<$($message.recipientEmail)>")
    Read-SmtpResponse $reader
    $writer.WriteLine("DATA")
    Read-SmtpResponse $reader
    $subjectBytes = [Text.Encoding]::UTF8.GetBytes([string]$message.subject)
    $encodedSubject = [Convert]::ToBase64String($subjectBytes)
    $writer.WriteLine("Date: $([DateTimeOffset]::Now.ToString('r'))")
    $writer.WriteLine("Message-ID: <$($message.messageKey)@one-man-company.test>")
    $writer.WriteLine("From: <$($message.senderEmail)>")
    $writer.WriteLine("To: <$($message.recipientEmail)>")
    $writer.WriteLine("Subject: =?UTF-8?B?$encodedSubject?=")
    $writer.WriteLine("MIME-Version: 1.0")
    $writer.WriteLine("Content-Type: text/plain; charset=utf-8")
    $writer.WriteLine("Content-Transfer-Encoding: 8bit")
    $writer.WriteLine("X-One-Man-Company-Message-Key: $($message.messageKey)")
    $writer.WriteLine("")
    foreach ($line in ([string]$message.body -split "`r?`n")) {
      $writer.WriteLine($(if ($line.StartsWith(".")) { ".$line" } else { $line }))
    }
    $writer.WriteLine(".")
    Read-SmtpResponse $reader
    $writer.WriteLine("QUIT")
    $reader.Dispose()
    $writer.Dispose()
  } finally {
    $client.Dispose()
  }
}

foreach ($message in @($mailroom.messages | Where-Object { $_.status -eq "queued" })) {
  $sending = @{ action = "reportDelivery"; messageKey = $message.messageKey; status = "sending" } | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri "$($ControlUrl.TrimEnd('/'))/api/mail" -Headers $headers -Method Post -ContentType "application/json" -Body $sending | Out-Null
  try {
    Send-StalwartMessage $message
    $sent = @{ action = "reportDelivery"; messageKey = $message.messageKey; status = "sent" } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "$($ControlUrl.TrimEnd('/'))/api/mail" -Headers $headers -Method Post -ContentType "application/json" -Body $sent | Out-Null
  } catch {
    $failed = @{ action = "reportDelivery"; messageKey = $message.messageKey; status = "failed"; lastError = $_.Exception.Message } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "$($ControlUrl.TrimEnd('/'))/api/mail" -Headers $headers -Method Post -ContentType "application/json" -Body $failed | Out-Null
  }
}

Write-Output "Mail delivery reconciliation complete."
