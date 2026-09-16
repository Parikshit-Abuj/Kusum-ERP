import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = path.join(projectRoot, 'package.json');
const packagerPath = path.join(projectRoot, 'node_modules', '@electron', 'packager', 'bin', 'electron-packager.mjs');
const iconPath = path.join(projectRoot, 'public', 'kusum-app-icon.png');

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function resolvedOutputPath() {
  const requested = option('--output');
  if (requested) return path.resolve(requested);
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 12);
  return path.join(projectRoot, 'output', `kusum-erp-linux-${stamp}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
      ...options
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${command} stopped with ${signal ? `signal ${signal}` : `exit code ${code}`}.`));
    });
  });
}

function electronCacheDirectory(version, platform, arch) {
  const downloadUrl = new URL(`https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-${platform}-${arch}.zip`);
  downloadUrl.hash = '';
  downloadUrl.search = '';
  downloadUrl.pathname = path.posix.dirname(downloadUrl.pathname);
  return crypto.createHash('sha256').update(downloadUrl.toString()).digest('hex');
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function assertFile(filePath, label) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size === 0) throw new Error(`${label} is empty.`);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${label} is missing: ${filePath}`);
    throw error;
  }
}

async function main() {
  const outputPath = resolvedOutputPath();
  const arch = option('--arch', 'x64');
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Linux architecture must be x64 or arm64.');
  if (await fs.stat(outputPath).then(() => true).catch(() => false)) {
    throw new Error(`Build output already exists at ${outputPath}. Choose a new empty folder; this script never overwrites a previous delivery.`);
  }
  await assertFile(packagerPath, 'Electron Packager');
  await assertFile(iconPath, 'Linux application icon');

  const sourceMigrationRoot = path.join(projectRoot, 'prisma', 'migrations');
  const migrationDirectories = (await fs.readdir(sourceMigrationRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (!migrationDirectories.length) throw new Error('No database migrations are present.');
  for (const migration of migrationDirectories) {
    await assertFile(path.join(sourceMigrationRoot, migration, 'migration.sql'), `Migration ${migration}`);
  }

  const packageJson = await readJson(packageJsonPath);
  const electronVersion = packageJson.devDependencies?.electron;
  if (!electronVersion) throw new Error('The pinned Electron dependency is missing from package.json.');
  const generatedClientSource = path.join(projectRoot, 'node_modules', '.prisma', 'client');
  await assertFile(path.join(generatedClientSource, 'index.js'), 'Generated Prisma client');
  const generatedClientFiles = await fs.readdir(generatedClientSource);
  if (!generatedClientFiles.some((name) => /^(?:lib)?query_engine-(?:debian-openssl-3\.0\.x|linux)/i.test(name))) {
    throw new Error('A Linux Prisma query engine is not generated. Run "npm run db:generate" on the Linux build host, then run this package command again.');
  }

  await fs.mkdir(outputPath, { recursive: true });
  const electronCache = path.join(projectRoot, '.electron-cache-linux');
  await fs.mkdir(electronCache, { recursive: true });
  const cachedElectronZipDirectory = path.join(
    electronCache,
    electronCacheDirectory(electronVersion, 'linux', arch)
  );
  const cachedElectronZip = path.join(
    cachedElectronZipDirectory,
    `electron-v${electronVersion}-linux-${arch}.zip`
  );
  const packagerArgs = [
    projectRoot,
    'Kusum ERP',
    `--platform=linux`,
    `--arch=${arch}`,
    `--icon=${iconPath}`,
    `--out=${outputPath}`,
    `--download.cacheRoot=${electronCache}`,
    '--no-asar',
    '--overwrite',
    '--prune=true',
    '--ignore=^/(?!electron-main\\.js$|package\\.json$|public(?:/|$)|src(?:/|$)|prisma(?:/|$)).*',
    '--ignore=^/prisma/(?!schema\\.prisma$|migrations(?:/|$)).*',
    '--ignore=^/src/excel-runtime/node_modules(?:/|$)'
  ];
  if (await fs.stat(cachedElectronZip).then(() => true).catch(() => false)) {
    // A cached ZIP is sufficient for an offline build. Passing it directly
    // avoids @electron/get trying to fetch SHASUMS256.txt from GitHub.
    packagerArgs.push(`--electron-zip-dir=${cachedElectronZipDirectory}`);
  }
  if (process.platform !== 'linux') {
    console.warn('Cross-packaging Linux from a non-Linux host. For the most reliable Prisma and native dependency result, run this command on the target Linux build host.');
  }
  await run(process.execPath, [packagerPath, ...packagerArgs], {
    env: {
      ...process.env,
      ELECTRON_CACHE: electronCache,
      electron_config_cache: electronCache
    }
  });

  const applicationDirectory = path.join(outputPath, `Kusum ERP-linux-${arch}`);
  await assertFile(path.join(applicationDirectory, 'Kusum ERP'), 'Packaged Linux ERP executable');
  const packagedMigrationsRoot = path.join(applicationDirectory, 'resources', 'app', 'prisma', 'migrations');
  for (const migration of migrationDirectories) {
    await assertFile(path.join(packagedMigrationsRoot, migration, 'migration.sql'), `Packaged migration ${migration}`);
  }

  // Electron Packager prunes development dependencies. Preserve the generated
  // Prisma client and its Linux query engine required by the production ORM.
  const packagedNodeModules = path.join(applicationDirectory, 'resources', 'app', 'node_modules');
  const packagedPrismaRoot = path.join(packagedNodeModules, '.prisma');
  await fs.rm(packagedPrismaRoot, { recursive: true, force: true });
  await fs.mkdir(packagedPrismaRoot, { recursive: true });
  await fs.cp(generatedClientSource, path.join(packagedPrismaRoot, 'client'), { recursive: true });
  const packagedClientFiles = await fs.readdir(path.join(packagedPrismaRoot, 'client'));
  if (!packagedClientFiles.some((name) => /^(?:lib)?query_engine-(?:debian-openssl-3\.0\.x|linux)/i.test(name))) {
    throw new Error('The packaged application is missing its Linux Prisma query engine.');
  }

  const copiedEnv = path.join(applicationDirectory, 'resources', 'app', '.env');
  await fs.rm(copiedEnv, { force: true });
  const readme = `Kusum ERP - Linux package

Supported target: Ubuntu/Debian 64-bit (${arch}).

1. Install MySQL Server on the main database PC and install/start CUPS for USB or shared printers.
2. From this folder, run: ./Kusum ERP
3. Choose Main Database PC during first setup, or Client Counter PC to connect to an existing main PC.
4. In printer setup, choose CUPS printer / USB for an installed CUPS queue, or Direct TCP / Ethernet for a network TSPL printer.
5. Copy the entire "Kusum ERP-linux-${arch}" folder when moving the application. Do not copy only the executable.

The package includes the production migrations and Linux Prisma runtime. No .env credentials, development database, QA files, or test records are included.
`;
  await fs.writeFile(path.join(outputPath, 'READ-ME-FIRST-LINUX.txt'), readme, 'utf8');
  console.log(`Linux desktop ERP created: ${applicationDirectory}`);
}

main().catch((error) => {
  console.error(`Linux packaging failed: ${error.message || error}`);
  process.exitCode = 1;
});
