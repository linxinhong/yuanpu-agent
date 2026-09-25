param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\@yuanpu-agentdesktop'),
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
$resources = Join-Path $InstallRoot 'resources'
$runtime = Join-Path $resources 'runtime\YuanpuAgentRuntime-win32-x64.exe'
$capabilityRoot = Join-Path $resources 'capabilities\builtin.python.echo\YuanpuEchoMcp'
$capability = Join-Path $capabilityRoot 'YuanpuEchoMcp.exe'
foreach ($file in @($runtime, $capability)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    throw "Required installed file is missing: $file"
  }
}

# Use a fresh process environment; do not read the user's Yuanpu configuration.
$probeRoot = Join-Path ([IO.Path]::GetTempPath()) ('yuanpu-task008-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($probeRoot) | Out-Null
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $runtime
$start.Arguments = '--capability-smoke'
$start.WorkingDirectory = $probeRoot
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.EnvironmentVariables.Clear()
foreach ($name in @('SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP')) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value) { $start.EnvironmentVariables[$name] = $value }
}
$start.EnvironmentVariables['PATH'] = Join-Path $env:SYSTEMROOT 'System32'
$start.EnvironmentVariables['YUANPU_HOME'] = Join-Path $probeRoot 'home'
$start.EnvironmentVariables['YUANPU_PYTHON_MCP_EXECUTABLE'] = $capability
$start.EnvironmentVariables['YUANPU_PYTHON_MCP_ROOT'] = $capabilityRoot
$start.EnvironmentVariables['YUANPU_PYTHON_MCP_ARGS'] = '[]'
$process = New-Object System.Diagnostics.Process
$process.StartInfo = $start
$watch = [Diagnostics.Stopwatch]::StartNew()
try {
  if (-not $process.Start()) { throw 'Installed Runtime did not start.' }
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    & (Join-Path $env:SYSTEMROOT 'System32\taskkill.exe') /PID $process.Id /T /F | Out-Null
    throw 'Installed Runtime capability smoke timed out.'
  }
  $output = $stdout.GetAwaiter().GetResult()
  $diagnostics = $stderr.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0) {
    throw "Installed Runtime exited with code $($process.ExitCode). $diagnostics"
  }
  $result = $output.Trim() | ConvertFrom-Json
  if (($result.tools -join ',') -ne 'search_capabilities,execute_capability') {
    throw 'Runtime did not expose the expected capability tools.'
  }
  if ($result.result.structuredContent.text -ne 'YuanpuAgent SEA' -or $result.result.structuredContent.length -ne 15) {
    throw 'Frozen Python capability returned an unexpected result.'
  }
  if ($result.errorResult.isError -ne $true -or $result.errorResult.content[0].text -notmatch 'diagnostic error') {
    throw 'MCP diagnostic error was not preserved.'
  }
  [ordered]@{
    status = 'passed'
    scenario = 'TASK-008 installed Windows capability smoke'
    platform = 'win32-x64'
    runtimeSha256 = (Get-FileHash -LiteralPath $runtime -Algorithm SHA256).Hash.ToLowerInvariant()
    capabilitySha256 = (Get-FileHash -LiteralPath $capability -Algorithm SHA256).Hash.ToLowerInvariant()
    noPythonOnPath = $true
    isolatedHome = $true
    elapsedSeconds = [Math]::Round($watch.Elapsed.TotalSeconds, 2)
    limits = @('Network isolation not tested', 'Desktop installation and update UI not tested', 'System Python may exist outside PATH')
  } | ConvertTo-Json -Depth 4
} finally {
  $process.Dispose()
  # Retain only the isolated probe directory for troubleshooting; never delete user data.
}
