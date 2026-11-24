param(
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version = "0.1.0",
  [string]$NodeVersion = "v22.21.1"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent (Split-Path -Parent $Root)
$DistDir = Join-Path $Root "dist"
$StageDir = Join-Path $DistDir "staging"
$RuntimeDir = Join-Path $StageDir "runtime"
$AppLinkDir = Join-Path $StageDir "app\link"
$CacheDir = Join-Path $DistDir "cache"

New-Item -ItemType Directory -Force -Path $StageDir, $RuntimeDir, $AppLinkDir, $CacheDir | Out-Null

# 1. Compile native Windows tray + supervisor
$Csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $Csc)) { throw "csc.exe not found at $Csc" }
$TrayOut = Join-Path $StageDir "SuperAgentLink.exe"
$TraySrc = Join-Path $Root "tray\LinkTray.cs"
$LinkIcon = Join-Path $Root "assets\SuperAgentLink.ico"
$VersionSrc = Join-Path $CacheDir "AssemblyVersion.cs"
@"
using System.Reflection;
[assembly: AssemblyVersion("$Version.0")]
[assembly: AssemblyFileVersion("$Version.0")]
"@ | Set-Content -LiteralPath $VersionSrc -Encoding Ascii
& $Csc /nologo /codepage:65001 /target:winexe /platform:x64 /optimize+ "/out:$TrayOut" "/win32icon:$LinkIcon" /reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll /reference:System.Security.dll $TraySrc $VersionSrc
if ($LASTEXITCODE -ne 0) { throw "csc.exe failed" }

# 2. Bundle Node.js x64 runtime
$NodeZipName = "node-$NodeVersion-win-x64.zip"
$NodeZip = Join-Path $CacheDir $NodeZipName
$NodeUrl = "https://nodejs.org/dist/$NodeVersion/$NodeZipName"
if (-not (Test-Path $NodeZip)) {
  Write-Host "Downloading $NodeUrl ..."
  Invoke-WebRequest -Uri $NodeUrl -OutFile $NodeZip
}
$NodeExtract = Join-Path $CacheDir "node-$NodeVersion-win-x64"
if (-not (Test-Path (Join-Path $NodeExtract "node.exe"))) {
  Expand-Archive -Path $NodeZip -DestinationPath $CacheDir -Force
}
Copy-Item -Path (Join-Path $NodeExtract "node.exe") -Destination (Join-Path $RuntimeDir "node.exe") -Force
Copy-Item -LiteralPath (Join-Path $NodeExtract "LICENSE") -Destination $RuntimeDir -Force

# 3. Copy apps/link payload
$RepoLinkDir = Join-Path $RepoRoot "apps\link"
if (-not (Test-Path -LiteralPath (Join-Path $RepoLinkDir "start.mjs") -PathType Leaf)) {
  throw "Missing apps/link/start.mjs; the installer would not have a Link client."
}
Copy-Item -Path (Join-Path $RepoLinkDir "*") -Destination $AppLinkDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $Root "installer\Register-LogonTask.ps1") -Destination $StageDir -Force

# 4. Build NSIS installer
$MakensisCmd = Get-Command makensis -ErrorAction SilentlyContinue
$MakensisExe = if ($MakensisCmd) { $MakensisCmd.Source } else { $null }
if (-not $MakensisExe) {
  $DefaultNsis = "C:\Program Files (x86)\NSIS\makensis.exe"
  if (Test-Path $DefaultNsis) { $MakensisExe = $DefaultNsis }
}
if (-not $MakensisExe) { throw "makensis.exe not found. Install NSIS first." }

$OutExe = Join-Path $DistDir "SuperAgentLink-Setup-x64.exe"
$Nsi = Join-Path $Root "installer\SuperAgentLink.nsi"
& $MakensisExe "/DAPP_VERSION=$Version" "/DSTAGE_DIR=$StageDir" "/DOUT_FILE=$OutExe" "/DLINK_ICON=$LinkIcon" $Nsi
if ($LASTEXITCODE -ne 0) { throw "makensis failed" }

$Hash = (Get-FileHash -Path $OutExe -Algorithm SHA256).Hash.ToLowerInvariant()
"$Hash  SuperAgentLink-Setup-x64.exe" | Set-Content -Path (Join-Path $DistDir "SHA256SUMS.txt") -Encoding Ascii
Write-Host "Built $OutExe ($Hash)"
