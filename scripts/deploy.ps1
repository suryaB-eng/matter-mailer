[CmdletBinding()]
param(
  [switch]$BundleOnly,
  [switch]$UploadEnv,
  [string]$KeyPath,
  [string]$KnownHostsPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $repo
if (-not $KeyPath) { $KeyPath = Join-Path $repo 'tmp/ssh/matter-mailer' }
if (-not $KnownHostsPath) { $KnownHostsPath = Join-Path $repo 'tmp/ssh/known_hosts' }

# Explicit allowlist: confidential input, .env, caches, downloads and logs cannot enter.
$files = @('package.json','package-lock.json','tsconfig.json','Dockerfile','compose.yaml','.dockerignore','docker/playwright-seccomp.json','scripts/remote-deploy.sh')
$files += @(Get-ChildItem -LiteralPath (Join-Path $repo 'src') -Recurse -File -Filter '*.ts' | ForEach-Object {
  if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Symlink source rejected' }
  $_.FullName.Substring($repo.Length + 1).Replace('\','/')
})
foreach ($file in $files) {
  $item = Get-Item -LiteralPath (Join-Path $repo $file)
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Symlink rejected: $file" }
}
$output = Join-Path $repo 'tmp/deploy'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$bundle = Join-Path $output 'source.tar.gz'
& tar -czf $bundle -- @files
if ($LASTEXITCODE -ne 0) { throw 'Source bundle creation failed' }
$hash = (Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant()
$entries = @(& tar -tzf $bundle)
if ($LASTEXITCODE -ne 0 -or $entries.Count -ne $files.Count -or @($entries | Where-Object { $_ -notin $files }).Count) { throw 'Archive allowlist verification failed' }
Write-Output "Source bundle SHA256: $hash"
if ($BundleOnly) { Write-Output $bundle; return }

$subscription = 'bed4cb6c-f8ca-4dbb-91cf-c500e8e4a2e7'
$group = 'rg-matter-mailer-assessment'
$vm = 'vm-matter-mailer'
$az = (Get-Command az -ErrorAction SilentlyContinue)
$azPath = if ($az) { $az.Source } else { 'C:/Program Files/Microsoft SDKs/Azure/CLI2/wbin/az.cmd' }
$vmJson = & $azPath vm show --subscription $subscription -g $group -n $vm -d -o json
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify authorized VM; no deployment attempted' }
$identity = ($vmJson -join "`n") | ConvertFrom-Json
if ($identity.tags.project -ne 'matter-mailer-assessment') { throw 'VM project identity mismatch' }
$address = [string]$identity.publicIps
$ip = $null
if (-not [Net.IPAddress]::TryParse($address, [ref]$ip) -or $ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'Expected one authorized VM IPv4' }
if (-not (Test-Path -LiteralPath $KeyPath) -or -not (Test-Path -LiteralPath $KnownHostsPath)) { throw 'SSH key and authenticated pinned host key required (see README)' }
$sshConfig = Join-Path $output 'ssh-config'
$keyForConfig = [IO.Path]::GetFullPath($KeyPath).Replace('\','/')
$hostsForConfig = [IO.Path]::GetFullPath($KnownHostsPath).Replace('\','/')
if ($keyForConfig -match '["\r\n]' -or $hostsForConfig -match '["\r\n]') { throw 'Invalid SSH path' }
# A config file keeps Windows paths with spaces quoted for OpenSSH itself.
$sshConfigText = "Host *`n  BatchMode yes`n  StrictHostKeyChecking yes`n  IdentitiesOnly yes`n  IdentityFile `"$keyForConfig`"`n  UserKnownHostsFile `"$hostsForConfig`"`n"
[IO.File]::WriteAllText($sshConfig,$sshConfigText,[Text.Encoding]::UTF8)
$sshArgs = @('-F',$sshConfig)
$target = "operator@$address"
& ssh @sshArgs $target 'install -d -m 700 /opt/matter-mailer/incoming'
if ($LASTEXITCODE -ne 0) { throw 'SSH setup failed' }
& scp @sshArgs $bundle "${target}:/opt/matter-mailer/incoming/source-$hash.tar.gz"
if ($LASTEXITCODE -ne 0) { throw 'Bundle transfer failed' }
if ($UploadEnv) {
  # Secret transfer is separate from source. No values in shell arguments/logs.
  if (-not (Test-Path -LiteralPath .env)) { throw 'Local ignored .env missing' }
  & scp @sshArgs .env "${target}:/opt/matter-mailer/incoming/env.new"
  if ($LASTEXITCODE -ne 0) { throw 'Credential transfer failed' }
}
& scp @sshArgs scripts/remote-deploy.sh "${target}:/opt/matter-mailer/incoming/deploy.sh"
if ($LASTEXITCODE -ne 0) { throw 'Deployment script transfer failed' }
$envFlag = if ($UploadEnv) { 'yes' } else { 'no' }
& ssh @sshArgs $target "bash /opt/matter-mailer/incoming/deploy.sh $hash $envFlag"
if ($LASTEXITCODE -ne 0) { throw 'Remote deployment failed' }
