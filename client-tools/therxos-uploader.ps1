# TheRxOS Auto-Uploader
# Watches Desktop\TheRxOS folder for CSV files and uploads them to the TheRxOS API
# Runs as a Windows Scheduled Task every 30 minutes

$ErrorActionPreference = "Continue"

# Paths
$configDir = Join-Path $env:APPDATA "TheRxOS"
$configFile = Join-Path $configDir "config.json"
$logFile = Join-Path $configDir "upload.log"
$desktopPath = [Environment]::GetFolderPath("Desktop")
$watchFolder = Join-Path $desktopPath "TheRxOS"
$sentFolder = Join-Path $watchFolder "Sent"

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $entry = "[$timestamp] $Message"
    Add-Content -Path $logFile -Value $entry -ErrorAction SilentlyContinue
}

# Ensure directories exist
if (-not (Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir -Force | Out-Null }
if (-not (Test-Path $watchFolder)) { New-Item -ItemType Directory -Path $watchFolder -Force | Out-Null }
if (-not (Test-Path $sentFolder)) { New-Item -ItemType Directory -Path $sentFolder -Force | Out-Null }

# Read config
if (-not (Test-Path $configFile)) {
    Write-Log "ERROR: Config file not found at $configFile. Run the installer first."
    exit 1
}

try {
    $config = Get-Content $configFile -Raw | ConvertFrom-Json
} catch {
    Write-Log "ERROR: Failed to read config: $_"
    exit 1
}

$apiKey = $config.apiKey
$serverUrl = $config.serverUrl

if (-not $apiKey -or -not $serverUrl) {
    Write-Log "ERROR: Config missing apiKey or serverUrl"
    exit 1
}

$uploadUrl = "$serverUrl/api/auto-upload"

# Find CSV files in watch folder (not in Sent subfolder)
$csvFiles = Get-ChildItem -Path $watchFolder -Filter "*.csv" -File -ErrorAction SilentlyContinue

if ($csvFiles.Count -eq 0) {
    # No files to process - silent exit (don't spam the log)
    exit 0
}

Write-Log "Found $($csvFiles.Count) CSV file(s) to upload"

foreach ($file in $csvFiles) {
    $filePath = $file.FullName
    $fileName = $file.Name

    Write-Log "Uploading: $fileName ($([math]::Round($file.Length / 1KB, 1)) KB)"

    try {
        # Build multipart form data
        $boundary = [System.Guid]::NewGuid().ToString()
        $LF = "`r`n"

        $fileBytes = [System.IO.File]::ReadAllBytes($filePath)
        $fileEnc = [System.Text.Encoding]::GetEncoding("iso-8859-1").GetString($fileBytes)

        $bodyLines = @(
            "--$boundary",
            "Content-Disposition: form-data; name=`"file`"; filename=`"$fileName`"",
            "Content-Type: text/csv",
            "",
            $fileEnc,
            "--$boundary--"
        )
        $body = $bodyLines -join $LF

        $headers = @{
            "x-api-key" = $apiKey
        }

        $response = Invoke-RestMethod -Uri $uploadUrl `
            -Method Post `
            -ContentType "multipart/form-data; boundary=$boundary" `
            -Body $body `
            -Headers $headers `
            -TimeoutSec 300

        if ($response.success) {
            $patients = $response.patients
            $prescriptions = $response.prescriptions
            Write-Log "SUCCESS: $fileName - $patients patients, $prescriptions prescriptions"

            # Move to Sent folder with timestamp
            $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
            $sentName = "$($file.BaseName)_$timestamp$($file.Extension)"
            $sentPath = Join-Path $sentFolder $sentName
            Move-Item -Path $filePath -Destination $sentPath -Force
            Write-Log "Moved to Sent: $sentName"
        } else {
            Write-Log "FAILED: $fileName - Server returned: $($response | ConvertTo-Json -Compress)"
        }
    } catch {
        $errorMsg = $_.Exception.Message
        if ($_.Exception.Response) {
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $errorBody = $reader.ReadToEnd()
                $errorMsg = "$errorMsg - $errorBody"
            } catch {}
        }
        Write-Log "ERROR: $fileName - $errorMsg"
    }
}

Write-Log "Upload cycle complete"
