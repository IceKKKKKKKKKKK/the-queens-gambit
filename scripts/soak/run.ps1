[CmdletBinding()]
param(
  [ValidateSet("soak", "smoke")]
  [string]$Profile = "soak",

  [ValidateRange(0.1, 604800)]
  [double]$DurationSeconds = 14400,

  [ValidateRange(0.1, 300)]
  [double]$CheckpointIntervalSeconds = 5,

  [ValidateRange(30, 3600)]
  [double]$WorkerHangTimeoutSeconds = 300,

  [ValidateRange(0, 2147483647)]
  [int]$Seed = 20260809,

  [string]$OutputRoot = "outputs/soak",

  [string]$Resume,

  [switch]$Stop
)

$ErrorActionPreference = "Stop"
$RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$Supervisor = Join-Path $PSScriptRoot "supervisor.ts"
$NodeExecutable = (Get-Command node -ErrorAction Stop).Source

if ($Stop) {
  $StopRunDir = if ($Resume) {
    if ([System.IO.Path]::IsPathRooted($Resume)) {
      $Resume
    } else {
      Join-Path $RepositoryRoot $Resume
    }
  } else {
    $ResolvedOutputRoot = if ([System.IO.Path]::IsPathRooted($OutputRoot)) {
      $OutputRoot
    } else {
      Join-Path $RepositoryRoot $OutputRoot
    }
    $LatestPath = Join-Path $ResolvedOutputRoot "latest-run.json"
    if (-not (Test-Path -LiteralPath $LatestPath -PathType Leaf)) {
      throw "No latest soak run exists at $LatestPath"
    }
    $Latest = Get-Content -LiteralPath $LatestPath -Raw | ConvertFrom-Json
    $Latest.runDir
  }
  & $NodeExecutable --experimental-transform-types $Supervisor "--stop-run=$StopRunDir"
  exit $LASTEXITCODE
}

$Arguments = @(
  "--experimental-transform-types"
  $Supervisor
  "--duration-seconds=$DurationSeconds"
  "--checkpoint-interval-seconds=$CheckpointIntervalSeconds"
  "--worker-hang-timeout-seconds=$WorkerHangTimeoutSeconds"
  "--seed=$Seed"
  "--profile=$Profile"
  "--output-root=$OutputRoot"
)
if ($Resume) {
  $Arguments += "--resume=$Resume"
}

Push-Location -LiteralPath $RepositoryRoot
try {
  & $NodeExecutable @Arguments
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
