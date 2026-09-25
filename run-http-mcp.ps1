$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = if ($env:TESLA_MCP_ENV_FILE) { $env:TESLA_MCP_ENV_FILE } else { Join-Path $HOME '.config\tesla-battery-mcp\.env' }
if (-not (Test-Path $EnvFile)) { throw "Tesla Battery MCP configuration not found: $EnvFile" }
Get-Content $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
    $parts = $line.Split('=', 2)
    [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), 'Process')
  }
}
& node (Join-Path $Root 'dist\httpMcpServer.js')
exit $LASTEXITCODE
