# Fix Cloudflare Workers CI - pin deploy command to wrangler@4.92.0
# This updates the Workers Builds trigger so CI uses wrangler 4.92.0 directly
# (no npm install needed — pins wrangler version in the npx deploy command itself)
#
# USAGE: Run this script in PowerShell. When prompted, type your Cloudflare API token.
# Create an API token at https://dash.cloudflare.com/profile/api-tokens with:
#   - Workers Builds Configuration: Edit
#   - Workers Scripts: Read

$ACCOUNT_ID = "663d88f914500dcdd118f98d00ef5672"
$WORKER_NAME = "germ-fun"

Write-Host ""
Write-Host "========================================"
Write-Host " Cloudflare CI Deploy Command Fix"
Write-Host "========================================"
Write-Host ""
Write-Host "This script will:"
Write-Host "  1. CLEAR the build command (remove 'npm install')"
Write-Host "  2. Set deploy command to: npx wrangler@4.92.0 deploy"
Write-Host "     (pins wrangler directly - no package.json or npm install needed)"
Write-Host ""
Write-Host "You need a Cloudflare API token with these permissions:"
Write-Host "  - Workers Builds Configuration: Edit"
Write-Host "  - Workers Scripts: Read"
Write-Host ""
Write-Host "Create one at: https://dash.cloudflare.com/profile/api-tokens"
Write-Host ""

# Get API token securely from terminal (not from chat)
$secureToken = Read-Host -Prompt "Paste your Cloudflare API token here" -AsSecureString
$BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
$API_TOKEN = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)

$headers = @{
    "Authorization" = "Bearer $API_TOKEN"
    "Content-Type"  = "application/json"
}

Write-Host ""
Write-Host "Step 1: Getting Worker tag..."

try {
    $scriptsResponse = Invoke-RestMethod `
        -Uri "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts" `
        -Headers $headers `
        -Method GET

    $worker = $scriptsResponse.result | Where-Object { $_.id -eq $WORKER_NAME }
    if (-not $worker) {
        Write-Host "ERROR: Worker '$WORKER_NAME' not found. Check your API token permissions." -ForegroundColor Red
        exit 1
    }
    $workerTag = $worker.tag
    Write-Host "  Worker tag: $workerTag" -ForegroundColor Green
} catch {
    Write-Host "ERROR getting worker list: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Make sure your API token has 'Workers Scripts: Read' permission."
    exit 1
}

Write-Host ""
Write-Host "Step 2: Getting trigger UUID..."

try {
    $triggersResponse = Invoke-RestMethod `
        -Uri "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/builds/workers/$workerTag/triggers" `
        -Headers $headers `
        -Method GET

    $triggers = $triggersResponse.result
    if (-not $triggers -or $triggers.Count -eq 0) {
        Write-Host "ERROR: No triggers found for worker '$WORKER_NAME'." -ForegroundColor Red
        exit 1
    }

    Write-Host "  Found $($triggers.Count) trigger(s):"
    foreach ($t in $triggers) {
        Write-Host "    - $($t.trigger_name) [branches: $($t.branch_includes -join ', ')] deploy: $($t.deploy_command)"
    }

    # Find production trigger (master or main branch)
    $productionTrigger = $triggers | Where-Object {
        $_.branch_includes -contains "master" -or $_.branch_includes -contains "main"
    }
    if (-not $productionTrigger) {
        $productionTrigger = $triggers[0]
        Write-Host "  No master/main trigger found, using first trigger." -ForegroundColor Yellow
    }

    $triggerUUID = $productionTrigger.trigger_uuid
    Write-Host "  Using trigger: '$($productionTrigger.trigger_name)' (UUID: $triggerUUID)" -ForegroundColor Green
    Write-Host "  Current deploy command: $($productionTrigger.deploy_command)"
} catch {
    Write-Host "ERROR getting triggers: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Make sure your API token has 'Workers Builds Configuration: Edit' permission."
    exit 1
}

Write-Host ""
Write-Host "Step 3: Updating trigger deploy command..."

# Set build_command to "npm install" so it installs wrangler 4.92.0 from package.json
# Then deploy uses the locally installed wrangler 4.92.0
$patchBody = @{
    "build_command"  = ""
    "deploy_command" = "npx wrangler@4.92.0 deploy"
} | ConvertTo-Json

try {
    $patchResponse = Invoke-RestMethod `
        -Uri "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/builds/triggers/$triggerUUID" `
        -Headers $headers `
        -Method PATCH `
        -Body $patchBody

    Write-Host "  Build command cleared (no npm install needed)" -ForegroundColor Green
    Write-Host "  Deploy command set to: npx wrangler@4.92.0 deploy" -ForegroundColor Green
    Write-Host "  (wrangler 4.92.0 uses old PUT API - no Free plan CPU limit issue)" -ForegroundColor Green
} catch {
    Write-Host "ERROR updating trigger: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please update manually in the Cloudflare dashboard:"
    Write-Host "  1. Go to Workers & Pages > germ-fun > Settings > Builds"
    Write-Host "  2. Clear the Build command"
    Write-Host "  3. Set Deploy command: npx wrangler@4.92.0 deploy"
    exit 1
}

Write-Host ""
Write-Host "Step 4: Triggering a new build..."

$buildBody = @{ "branch" = "master" } | ConvertTo-Json

try {
    $buildResponse = Invoke-RestMethod `
        -Uri "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/builds/triggers/$triggerUUID/builds" `
        -Headers $headers `
        -Method POST `
        -Body $buildBody

    $buildUUID = $buildResponse.result.build_uuid
    Write-Host "  Build triggered! UUID: $buildUUID" -ForegroundColor Green
    Write-Host ""
    Write-Host "Monitor the build at:"
    Write-Host "  https://dash.cloudflare.com/$ACCOUNT_ID/workers/services/view/$WORKER_NAME/production/builds/$buildUUID"
} catch {
    Write-Host "WARNING: Could not trigger build automatically: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "The trigger was updated successfully. Push any commit to trigger a build, or trigger manually in the dashboard."
}

Write-Host ""
Write-Host "========================================"
Write-Host " Done! CI deploy command is now:"
Write-Host " npx wrangler@4.92.0 deploy"
Write-Host " (no build step, no package.json dependency)"
Write-Host "========================================"
Write-Host ""
