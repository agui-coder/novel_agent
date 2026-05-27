param(
    [ValidateSet("local", "public-demo")]
    [string]$Profile = "local",
    [string]$Env,
    [string]$BackendUrl,
    [string]$FrontendUrl,
    [string]$DifyUrl,
    [switch]$RequireDify,
    [string]$PublicBookId,
    [double]$Timeout = 5,
    [switch]$Strict,
    [switch]$Json
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Doctor = Join-Path $ScriptDir "deploy_doctor.py"

$argsList = @("--profile", $Profile, "--timeout", [string]$Timeout)
if ($Env) { $argsList += @("--env", $Env) }
if ($BackendUrl) { $argsList += @("--backend-url", $BackendUrl) }
if ($FrontendUrl) { $argsList += @("--frontend-url", $FrontendUrl) }
if ($DifyUrl) { $argsList += @("--dify-url", $DifyUrl) }
if ($RequireDify) { $argsList += "--require-dify" }
if ($PublicBookId) { $argsList += @("--public-book-id", $PublicBookId) }
if ($Strict) { $argsList += "--strict" }
if ($Json) { $argsList += "--json" }

python $Doctor @argsList
