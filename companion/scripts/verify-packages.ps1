param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root '.output'
$version = (Get-Content -Raw (Join-Path $root 'package.json') | ConvertFrom-Json).version
$prefix = "filter-observatory-companion-$version"
$evidenceDirectory = Join-Path $root 'test-results'
$rebuild = Join-Path $evidenceDirectory ('source-rebuild-' + [guid]::NewGuid().ToString('N'))
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-TreeHash([string]$directory) {
  $hashes = [ordered]@{}
  Get-ChildItem -LiteralPath $directory -File -Recurse | Sort-Object FullName | ForEach-Object {
    $name = [IO.Path]::GetRelativePath($directory, $_.FullName).Replace('\', '/')
    $hashes[$name] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  return $hashes
}

$archives = [ordered]@{}
$sourceHashes = [ordered]@{}
foreach ($target in @('chrome', 'firefox', 'sources')) {
  $path = Join-Path $output "$prefix-$target.zip"
  $archive = [IO.Compression.ZipFile]::OpenRead($path)
  try {
    $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    if ($entries | Where-Object { $_ -match '(^/|(^|/)\.\.(/|$)|^[A-Za-z]:)' }) {
      throw "Unsafe archive entry in $path"
    }
    if ($target -eq 'sources') {
      $allowed = '^(entrypoints/|utils/|components/|assets/|public/|wxt\.config\.ts$|tsconfig\.json$|package(-lock)?\.json$|README\.md$)'
      if ($entries | Where-Object { $_ -notmatch $allowed -or $_ -match '(node_modules|\.env|\.private\.json|test-results|\.sqlite|\.log$)' }) {
        throw 'Source archive contains files outside the rebuild allowlist.'
      }
      foreach ($required in @('package.json', 'package-lock.json', 'wxt.config.ts', 'tsconfig.json', 'entrypoints/background.ts', 'utils/comparison.ts')) {
        if ($required -notin $entries) { throw "Missing source archive input: $required" }
      }
      foreach ($entry in $archive.Entries) {
        $name = $entry.FullName.Replace('\', '/')
        $stream = $entry.Open()
        try { $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant() }
        finally { $stream.Dispose() }
        $current = (Get-FileHash -LiteralPath (Join-Path $root $name) -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -ne $current) { throw "Source archive is stale: $name" }
        $sourceHashes[$name] = $hash
      }
      [IO.Directory]::CreateDirectory($rebuild) | Out-Null
      [IO.Compression.ZipFile]::ExtractToDirectory($path, $rebuild)
    }
    else {
      $directory = Join-Path $output $(if ($target -eq 'chrome') { 'chrome-mv3' } else { 'firefox-mv2' })
      $hashes = Get-TreeHash $directory
      if ($entries.Count -ne $hashes.Count) { throw "Archive/output count mismatch for $target" }
      foreach ($entry in $archive.Entries) {
        $name = $entry.FullName.Replace('\', '/')
        $stream = $entry.Open()
        try { $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant() }
        finally { $stream.Dispose() }
        if ($hashes[$name] -ne $hash) { throw "Archive differs from build output: $target/$name" }
      }
      $manifest = Get-Content -Raw (Join-Path $directory 'manifest.json') | ConvertFrom-Json
      $permissions = @($manifest.permissions | Where-Object { $_ -notmatch '^http' } | Sort-Object)
      if (($permissions -join ',') -ne 'activeTab,alarms,scripting,storage') { throw "Unexpected API permissions for $target" }
      $hosts = @(@($manifest.host_permissions) + @($manifest.permissions) | Where-Object { $_ -match '^http' } | Sort-Object)
      if (($hosts -join ',') -ne 'http://127.0.0.1/*,http://localhost/*') { throw "Unexpected host permissions for $target" }
      if ($manifest.content_scripts -or $manifest.web_accessible_resources) { throw "Unexpected automatic page access for $target" }
      $command = $manifest.commands.'capture-evidence'
      if (-not $command -or $command.global) { throw "Missing browser-scoped capture command for $target" }
      if ($target -eq 'chrome' -and ($command.suggested_key.windows -ne 'Ctrl+Q' -or $command.suggested_key.default)) {
        throw 'Chrome must suggest Ctrl+Q only on Windows.'
      }
      if ($target -eq 'firefox' -and $command.suggested_key) { throw 'Firefox must not inherit the Windows Chrome shortcut.' }
    }
    $archives[$target] = [ordered]@{
      path = $path
      bytes = (Get-Item -LiteralPath $path).Length
      sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
      entries = $entries
    }
  }
  finally { $archive.Dispose() }
}

# Resolve tooling from the existing pinned companion dependencies; source inputs come only from the archive.
Push-Location $rebuild
try {
  & node (Join-Path $root 'node_modules/wxt/bin/wxt.mjs') build -b firefox
  if ($LASTEXITCODE -ne 0) { throw "Extracted-source build failed with exit $LASTEXITCODE" }
}
finally { Pop-Location }

$expected = Get-TreeHash (Join-Path $output 'firefox-mv2')
$actual = Get-TreeHash (Join-Path $rebuild '.output/firefox-mv2')
if (($expected.Keys -join '|') -ne ($actual.Keys -join '|')) { throw 'Rebuilt file list differs from packaged output.' }
foreach ($name in $expected.Keys) {
  if ($expected[$name] -ne $actual[$name]) { throw "Rebuilt bytes differ: $name" }
}

$receipt = [ordered]@{
  verifiedAt = [DateTime]::UtcNow.ToString('o')
  archives = $archives
  sourceHashes = $sourceHashes
  sourceRebuild = [ordered]@{
    path = $rebuild
    installedDependencies = (Join-Path $root 'node_modules')
    matchedFiles = $actual.Count
    hashes = $actual
  }
}
$receiptPath = Join-Path $evidenceDirectory 'packages.json'
$receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding utf8
Write-Output "Verified Chrome/Firefox archives and all $($actual.Count) rebuilt Firefox files. Receipt: $receiptPath"
