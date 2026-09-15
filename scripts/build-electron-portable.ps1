[CmdletBinding()]
param(
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$scriptDirectory = $PSScriptRoot
if (-not $scriptDirectory) { $scriptDirectory = Split-Path $MyInvocation.MyCommand.Path -Parent }
$projectRoot = Split-Path $scriptDirectory -Parent
$iconPath = Join-Path $projectRoot 'public\kusum-app-icon.ico'
if (-not (Test-Path -LiteralPath $iconPath)) { throw 'The Kusum Windows application icon is missing at public\kusum-app-icon.ico.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'output\kusum-erp-portable' }
$outputPath = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
  [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
}

if (Test-Path -LiteralPath $outputPath) {
  throw "Build output already exists at $outputPath. Choose a new empty folder; this script will never overwrite a previous delivery."
}

$packager = Join-Path $projectRoot 'node_modules\@electron\packager\bin\electron-packager.mjs'
if (-not (Test-Path -LiteralPath $packager)) { throw 'Electron Packager is missing. Run npm install first.' }

# Every migration directory is part of the production schema. Fail before
# packaging if one is incomplete so the migration runner cannot silently skip
# a required table on the shop PC.
$sourceMigrationsPath = Join-Path $projectRoot 'prisma\migrations'
if (-not (Test-Path -LiteralPath $sourceMigrationsPath -PathType Container)) {
  throw 'Unsafe build: the source prisma\migrations directory is missing.'
}
$sourceMigrationDirectories = @(Get-ChildItem -LiteralPath $sourceMigrationsPath -Directory -Force | Sort-Object Name)
if ($sourceMigrationDirectories.Count -eq 0) { throw 'Unsafe build: no database migrations are present.' }
foreach ($migrationDirectory in $sourceMigrationDirectories) {
  $migrationSqlPath = Join-Path $migrationDirectory.FullName 'migration.sql'
  if (-not (Test-Path -LiteralPath $migrationSqlPath -PathType Leaf)) {
    throw "Unsafe build: migration $($migrationDirectory.Name) is missing migration.sql."
  }
  if ((Get-Item -LiteralPath $migrationSqlPath).Length -eq 0) {
    throw "Unsafe build: migration $($migrationDirectory.Name) has an empty migration.sql."
  }
}

# electron-packager normally downloads Electron again. Create its expected ZIP
# from the already installed runtime so an offline release build remains possible.
$electronDist = Join-Path $projectRoot 'node_modules\electron\dist'
$electronCache = Join-Path $projectRoot '.electron-cache'
if (-not (Test-Path -LiteralPath $electronDist)) {
  $electronInstaller = Join-Path $projectRoot 'node_modules\electron\install.js'
  if (-not (Test-Path -LiteralPath $electronInstaller)) { throw 'The pinned Electron package is missing. Run npm install first.' }
  $previousElectronCache = $env:ELECTRON_CACHE
  $previousElectronConfigCache = $env:electron_config_cache
  try {
    $env:ELECTRON_CACHE = $electronCache
    # Electron 43's installer passes this variable directly to @electron/get.
    # Keep both names for compatibility with older and newer Electron tooling.
    $env:electron_config_cache = $electronCache
    & node $electronInstaller
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $electronDist)) {
      throw 'Could not download the pinned Electron Windows runtime.'
    }
  } finally {
    $env:ELECTRON_CACHE = $previousElectronCache
    $env:electron_config_cache = $previousElectronConfigCache
  }
}
$electronVersion = (& node -p "require('./node_modules/electron/package.json').version").Trim()
$electronZipDirectory = Join-Path ([System.IO.Path]::GetTempPath()) 'kusum-erp-electron-zips'
$electronZip = Join-Path $electronZipDirectory "electron-v$electronVersion-win32-x64.zip"
if (-not (Test-Path -LiteralPath $electronZip)) {
  New-Item -ItemType Directory -Path $electronZipDirectory -Force | Out-Null
  Compress-Archive -Path (Join-Path $electronDist '*') -DestinationPath $electronZip -CompressionLevel Optimal
}

New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
# Package only the desktop ERP.  Android Studio, Gradle and pnpm caches may
# live beside the source project on a development PC, but are never required
# by the shop application and can otherwise add more than a gigabyte.
# Use an allowlist-oriented set of filters. Only runtime application files and
# production dependencies may enter the shop package; development/audit scripts
# are deliberately unreachable from a client installation.
& node $packager $projectRoot 'Kusum ERP' --platform=win32 --arch=x64 --icon=$iconPath --out=$outputPath --overwrite --prune=true --asar=false --electron-zip-dir=$electronZipDirectory `
  --ignore='^/(?!electron-main\.js$|package\.json$|public(?:/|$)|src(?:/|$)|prisma(?:/|$)|scripts(?:/|$)|node_modules(?:/|$)).*' `
  --ignore='^/scripts/(?!print-tspl\.ps1$|list-printers\.ps1$).*' `
  --ignore='^/prisma/(?!schema\.prisma$|migrations(?:/|$)).*' `
  --ignore='^/src/lib/unix-printers\.js$' `
  --ignore='^/src/excel-runtime/node_modules(?:/|$)'
if ($LASTEXITCODE -ne 0) { throw 'Could not package the Electron desktop ERP.' }

$applicationDirectory = Join-Path $outputPath 'Kusum ERP-win32-x64'
$desktopExe = Join-Path $applicationDirectory 'Kusum ERP.exe'
if (-not (Test-Path -LiteralPath $desktopExe)) { throw 'The portable ERP executable was not created.' }

$packagedMigrationsPath = Join-Path $applicationDirectory 'resources\app\prisma\migrations'
if (-not (Test-Path -LiteralPath $packagedMigrationsPath -PathType Container)) {
  throw 'Unsafe build: the packaged prisma\migrations directory is missing.'
}
foreach ($migrationDirectory in $sourceMigrationDirectories) {
  $packagedMigrationDirectory = Join-Path $packagedMigrationsPath $migrationDirectory.Name
  $packagedMigrationSqlPath = Join-Path $packagedMigrationDirectory 'migration.sql'
  if (-not (Test-Path -LiteralPath $packagedMigrationSqlPath -PathType Leaf)) {
    throw "Unsafe build: packaged migration $($migrationDirectory.Name) is missing migration.sql."
  }
  if ((Get-Item -LiteralPath $packagedMigrationSqlPath).Length -eq 0) {
    throw "Unsafe build: packaged migration $($migrationDirectory.Name) has an empty migration.sql."
  }
}

$packagedScripts = Join-Path $applicationDirectory 'resources\app\scripts'
if (-not (Test-Path -LiteralPath $packagedScripts)) { throw 'Unsafe build: the required runtime scripts directory is missing.' }
$unexpectedScripts = @(Get-ChildItem -LiteralPath $packagedScripts -File -Force | Where-Object { $_.Name -notin @('print-tspl.ps1', 'list-printers.ps1') })
if ($unexpectedScripts.Count -gt 0) {
  throw "Unsafe build: unexpected scripts were packaged: $($unexpectedScripts.Name -join ', ')"
}
foreach ($requiredScript in @('print-tspl.ps1', 'list-printers.ps1')) {
  if (-not (Test-Path -LiteralPath (Join-Path $packagedScripts $requiredScript))) { throw "Unsafe build: required runtime script $requiredScript is missing." }
}
$packagedUnixPrinter = Join-Path $applicationDirectory 'resources\app\src\lib\unix-printers.js'
if (Test-Path -LiteralPath $packagedUnixPrinter) {
  throw 'Unsafe build: the Windows package contains the Linux-only printer backend.'
}

# Electron Packager prunes development packages. Preserve the generated Prisma
# Windows client required by the production ORM at runtime.
$generatedClientSource = Join-Path $projectRoot 'node_modules\.prisma\client'
$applicationNodeModules = Join-Path $applicationDirectory 'resources\app\node_modules'
$generatedPrismaDirectory = Join-Path $applicationNodeModules '.prisma'
$generatedClientDestination = Join-Path $generatedPrismaDirectory 'client'
if (-not (Test-Path -LiteralPath $generatedClientSource)) { throw 'The generated Prisma client is missing. Run npm run db:generate before packaging.' }
if (Test-Path -LiteralPath $generatedPrismaDirectory) { Remove-Item -LiteralPath $generatedPrismaDirectory -Recurse -Force }
New-Item -ItemType Directory -Path $generatedPrismaDirectory -Force | Out-Null
Copy-Item -LiteralPath $generatedClientSource -Destination $generatedPrismaDirectory -Recurse -Force
Get-ChildItem -LiteralPath $generatedClientDestination -Filter '*.tmp*' -File -Force | Remove-Item -Force

# npm can retain Prisma's optional CLI peer while pruning. The generated client
# and @prisma/client are the only Prisma runtime pieces the ERP needs; remove
# migration/config/engine download tooling from the deliverable explicitly.
$prismaCli = Join-Path $applicationNodeModules 'prisma'
if (Test-Path -LiteralPath $prismaCli) { Remove-Item -LiteralPath $prismaCli -Recurse -Force }
$prismaNamespace = Join-Path $applicationNodeModules '@prisma'
if (Test-Path -LiteralPath $prismaNamespace) {
  Get-ChildItem -LiteralPath $prismaNamespace -Directory -Force | Where-Object { $_.Name -ne 'client' } | Remove-Item -Recurse -Force
}
$deepMerge = Join-Path $applicationNodeModules 'deepmerge-ts'
if (Test-Path -LiteralPath $deepMerge) { Remove-Item -LiteralPath $deepMerge -Recurse -Force }
if (Test-Path -LiteralPath $prismaCli) { throw 'Unsafe build: Prisma development CLI remained in the portable application.' }

# ExcelJS pulls TypeScript declarations through its CSV helper even though the
# desktop ERP executes plain JavaScript. Electron Packager can also leave an
# empty @electron namespace behind. Neither namespace is needed at runtime.
foreach ($developmentNamespace in @('@electron', '@types')) {
  $namespacePath = Join-Path $applicationNodeModules $developmentNamespace
  if (Test-Path -LiteralPath $namespacePath) { Remove-Item -LiteralPath $namespacePath -Recurse -Force }
}

# Neither cache is used at runtime. Removing them makes the portable folder
# smaller without changing the ERP's production dependencies.
$packageCache = Join-Path $applicationNodeModules '.cache'
if (Test-Path -LiteralPath $packageCache) { Remove-Item -LiteralPath $packageCache -Recurse -Force }

# Do not recursively delete folders called test, tests or coverage from
# production dependencies. A package may legitimately load a file beneath
# one of those paths; deleting it can turn a valid release into a
# "Cannot find module" failure on the shop PC. Electron Packager's
# --prune=true already excludes declared development dependencies.

$copiedEnv = Join-Path $applicationDirectory 'resources\app\.env'
if (Test-Path -LiteralPath $copiedEnv) { Remove-Item -LiteralPath $copiedEnv -Force }

# Load the core production modules from the packaged application's own
# node_modules folder. This catches incomplete dependency copies before a
# release folder is handed to the shop, without starting the ERP or touching
# MySQL data.
$moduleSmokeTest = @'
const path = require('path');
const { createRequire } = require('module');
const appDirectory = process.argv[1];
const requireFromPackage = createRequire(path.join(appDirectory, 'package.json'));
for (const dependency of [
  'express', 'body-parser', 'ejs', 'express-session', 'mysql2',
  '@prisma/client', 'exceljs', 'pdfkit', 'qrcode', 'dotenv'
]) requireFromPackage(dependency);
console.log('Packaged ERP production dependencies loaded successfully.');
'@
& node -e $moduleSmokeTest (Join-Path $applicationDirectory 'resources\app')
if ($LASTEXITCODE -ne 0) { throw 'Unsafe build: a required production dependency could not be loaded from the packaged ERP.' }

$instructions = @'
Kusum ERP - Portable desktop package

Single-PC setup
1. Copy this entire "Kusum ERP-win32-x64" folder to the shop PC. Do not copy only the EXE; it needs the files beside it.
2. Install and start MySQL Server on that PC, then install the TSC TTP-244 Pro Windows driver.
3. Double-click "Kusum ERP.exe" and select "Main database PC" at first setup.

Shared main-PC / client-PC setup
1. Install MySQL Server only on the main database PC. On first ERP start there, choose "Main database PC", use localhost and the selected MySQL port, then choose and note the shared ERP database username and password.
2. Ensure MySQL listens on the main PC's LAN adapter and allow the same MySQL port through Windows Firewall only for Private networks / Local subnet. Do not expose MySQL to the internet.
3. In the ERP on the main PC, open Network PCs. If the database already existed, create or reset the one shared ERP database login there. Use the shown LAN IP address, database name, port and that same login on every client PC; client PCs do not create another database.
4. Connect every client PC to the same router/switch (Wi-Fi or Ethernet LAN cable), run the ERP EXE, select "Client PC", and enter the main PC's LAN IP and MySQL port. Client PCs do not need MySQL Server or the MySQL root password.
5. In Barcode printer on every PC, use Windows printer / USB for a USB or Windows-shared TSC (recommended), or Direct TCP only for a reachable Ethernet printer or print server. Click Test TSC and confirm the physical test label.
6. If a PC has an old or incorrect saved database port, ERP automatically opens "Repair ERP connection" instead of requiring a Windows reset. Enter the current main-PC or client-PC details there; this changes only that PC's saved connection and never deletes shop data.

The ERP creates or upgrades the kusum_erp database. The MySQL administrator password is used only during main-PC setup and is never saved. Existing shop data is never deleted.

To update an existing shop installation: first close the ERP, then replace the entire old application folder with the new "Kusum ERP-win32-x64" folder. Do not delete the local kusum_erp MySQL database or the ERP settings in %LOCALAPPDATA%\Kusum Jewelers ERP; this preserves all shop data and setup.

No development database, credentials, or test records are included in this package. Internet and Node.js are not required on the shop PC.
'@
Set-Content -LiteralPath (Join-Path $outputPath 'READ-ME-FIRST.txt') -Value $instructions -Encoding utf8

Write-Host "Portable desktop ERP created: $applicationDirectory"
