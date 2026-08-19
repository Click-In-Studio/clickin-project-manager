$ErrorActionPreference = "Stop"

$workspacePath = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$envPath = Join-Path $workspacePath ".env.local"
$appId = "cli_a424f4a1effc900e"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

Write-Host "Click-In local Feishu setup"
Write-Host "App ID: $appId"
Write-Host ""

$secureSecret = Read-Host "Paste the Click-In Assistant App Secret (input is hidden)" -AsSecureString
$credential = New-Object System.Net.NetworkCredential("", $secureSecret)
$plainSecret = $credential.Password

if ([string]::IsNullOrWhiteSpace($plainSecret)) {
    throw "App Secret cannot be empty. No files were changed."
}

try {
    if (-not (Test-Path -LiteralPath $envPath)) {
        [System.IO.File]::WriteAllText($envPath, "", [System.Text.UTF8Encoding]::new($false))
    }

    $backupPath = "$envPath.backup-$timestamp"
    Copy-Item -LiteralPath $envPath -Destination $backupPath -ErrorAction Stop

    $lines = [System.Collections.Generic.List[string]]::new()
    [System.IO.File]::ReadAllLines($envPath) |
        Where-Object { -not $_.StartsWith("FEISHU_REDIRECT_URI=") } |
        ForEach-Object { [void]$lines.Add($_) }

    $appIdUpdated = $false
    $secretUpdated = $false

    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index].StartsWith("FEISHU_APP_ID=")) {
            $lines[$index] = "FEISHU_APP_ID=$appId"
            $appIdUpdated = $true
        }
        elseif ($lines[$index].StartsWith("FEISHU_APP_SECRET=")) {
            $lines[$index] = "FEISHU_APP_SECRET=$plainSecret"
            $secretUpdated = $true
        }
    }

    if (-not $appIdUpdated) {
        $lines.Insert(0, "FEISHU_APP_ID=$appId")
    }
    if (-not $secretUpdated) {
        $lines.Insert(1, "FEISHU_APP_SECRET=$plainSecret")
    }

    $utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllLines($envPath, $lines, $utf8WithoutBom)

    Write-Host ""
    Write-Host "Configuration saved. Secret is not displayed."
    Write-Host "Backup: $backupPath"

    Write-Host "Stopping old Click-In Next.js development processes..."
    $projectNodeProcesses = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine.Contains($workspacePath) -and
            (
                $_.CommandLine -like "*next*dist*bin*next* dev*" -or
                $_.CommandLine -like "*next*dist*server*start-server.js*"
            )
        }

    foreach ($projectProcess in $projectNodeProcesses) {
        Stop-Process -Id $projectProcess.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 800

    $cachePath = [System.IO.Path]::GetFullPath((Join-Path $workspacePath ".next"))
    $cacheParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $cachePath))
    $cacheLeaf = Split-Path -Leaf $cachePath
    if (-not $cacheParent.Equals($workspacePath, [System.StringComparison]::OrdinalIgnoreCase) -or $cacheLeaf -ne ".next") {
        throw "Refusing to remove unexpected cache path: $cachePath"
    }

    if (Test-Path -LiteralPath $cachePath) {
        Write-Host "Removing Next.js cache: $cachePath"
        Remove-Item -LiteralPath $cachePath -Recurse -Force
    }

    $npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
    $stdoutPath = Join-Path $workspacePath "local-main-oneclick-$timestamp.out.log"
    $stderrPath = Join-Path $workspacePath "local-main-oneclick-$timestamp.err.log"

    Write-Host "Starting the latest local main service..."
    $startArguments = @{
        FilePath = $npmCommand
        ArgumentList = @("run", "dev")
        WorkingDirectory = $workspacePath
        RedirectStandardOutput = $stdoutPath
        RedirectStandardError = $stderrPath
        WindowStyle = "Hidden"
        PassThru = $true
    }
    $launcher = Start-Process @startArguments

    $deadline = (Get-Date).AddSeconds(45)
    $response = $null
    do {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:3000/app" -UseBasicParsing -TimeoutSec 3
        }
        catch {
            Start-Sleep -Milliseconds 600
        }
    } while (-not $response -and (Get-Date) -lt $deadline)

    if (-not $response) {
        Write-Host "The service did not become ready. Check these logs:"
        Write-Host "  $stdoutPath"
        Write-Host "  $stderrPath"
        throw "Local service startup failed"
    }

    $headers = curl.exe -s -D - -o NUL --max-redirs 0 "http://127.0.0.1:3000/api/auth/feishu/initiate"
    $locationLine = $headers | Where-Object { $_ -like "location:*" } | Select-Object -First 1
    $location = $locationLine.Substring("location:".Length).Trim()
    $oauthAppId = [regex]::Match($location, "(?:[?&])app_id=([^&]+)").Groups[1].Value
    $encodedRedirect = [regex]::Match($location, "(?:[?&])redirect_uri=([^&]+)").Groups[1].Value
    $redirectUri = [System.Uri]::UnescapeDataString($encodedRedirect)

    if ($oauthAppId -ne $appId) {
        throw "OAuth verification returned an unexpected App ID: $oauthAppId"
    }

    Write-Host ""
    Write-Host "SUCCESS"
    Write-Host "App ID:       $oauthAppId"
    Write-Host "Redirect URI: $redirectUri"
    Write-Host "Local URL:    http://127.0.0.1:3000/app"
    Write-Host "Refresh the local login page and click Feishu login."
}
finally {
    $plainSecret = $null
    $credential = $null
    $secureSecret = $null
}
