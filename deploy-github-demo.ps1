# Wrapper for deploy-vera.ps1 -Target github
param(
  [string]$SourcePath = "C:\Users\User\Documents\VERA\Online_demo",
  [string]$ClonePath = "C:\Users\User\Documents\VERA-ai-git",
  [switch]$Force
)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$params = @{
  Target     = "github"
  SourcePath = $SourcePath
  ClonePath  = $ClonePath
}
if ($Force) { $params.Force = $true }
& (Join-Path $here "deploy-vera.ps1") @params
