import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const gzip = promisify(zlib.gzip);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = path.join(projectRoot, 'package.json');

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function architecture(value) {
  const requested = String(value || 'x64').toLowerCase();
  if (requested === 'x64' || requested === 'amd64') return { electron: 'x64', debian: 'amd64' };
  if (requested === 'arm64' || requested === 'aarch64') return { electron: 'arm64', debian: 'arm64' };
  throw new Error('Debian architecture must be x64/amd64 or arm64/aarch64.');
}

function outputDirectory() {
  const requested = option('--output');
  if (requested) return path.resolve(requested);
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 12);
  return path.join(projectRoot, 'output', `kusum-erp-deb-${stamp}`);
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

function field(value, length, label) {
  const bytes = Buffer.from(String(value), 'utf8');
  if (bytes.length > length) throw new Error(`${label} is too long for a Debian archive field.`);
  const result = Buffer.alloc(length, 0);
  bytes.copy(result);
  return result;
}

function spaceField(value, length, label) {
  const bytes = Buffer.from(String(value), 'utf8');
  if (bytes.length > length) throw new Error(`${label} is too long for an archive field.`);
  const result = Buffer.alloc(length, 0x20);
  bytes.copy(result);
  return result;
}

function octal(value, length) {
  const text = Math.max(0, Number(value) || 0).toString(8).padStart(length - 1, '0');
  if (text.length >= length) throw new Error(`Tar value ${value} is too large.`);
  return field(`${text}\0`, length, 'Tar numeric field');
}

function tarHeader(name, { mode = 0o644, size = 0, type = '0', mtime = 0 } = {}) {
  // A long directory path normally ends in `/`. Splitting that value at its
  // final slash would leave the tar `name` field empty; POSIX readers treat
  // that as an end-of-archive marker and never reach subsequent entries.
  // Directory type already carries the trailing-slash semantics, so omit it
  // from the stored path before using the USTAR prefix/name split.
  const suppliedName = name.replace(/\\/g, '/').replace(/^\.\//, '');
  const normalisedName = type === '5' ? suppliedName.replace(/\/+$/, '') : suppliedName;
  let entryName = normalisedName;
  let prefix = '';
  if (Buffer.byteLength(entryName) > 100) {
    const split = entryName.lastIndexOf('/', 155);
    if (split <= 0 || Buffer.byteLength(entryName.slice(split + 1)) > 100 || Buffer.byteLength(entryName.slice(0, split)) > 155) {
      throw new Error(`Tar path is too long: ${entryName}`);
    }
    prefix = entryName.slice(0, split);
    entryName = entryName.slice(split + 1);
  }
  const header = Buffer.alloc(512, 0);
  field(entryName, 100, 'Tar path').copy(header, 0);
  octal(mode, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(size, 12).copy(header, 124);
  octal(Math.floor(mtime), 12).copy(header, 136);
  Buffer.alloc(8, 0x20).copy(header, 148);
  field(type, 1, 'Tar entry type').copy(header, 156);
  field('ustar\0', 6, 'Tar magic').copy(header, 257);
  field('00', 2, 'Tar version').copy(header, 263);
  field('root', 32, 'Tar user').copy(header, 265);
  field('root', 32, 'Tar group').copy(header, 297);
  octal(0, 8).copy(header, 329);
  octal(0, 8).copy(header, 337);
  field(prefix, 155, 'Tar prefix').copy(header, 345);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  field(`${checksum.toString(8).padStart(6, '0')}\0 `, 8, 'Tar checksum').copy(header, 148);
  return header;
}

function paddedLength(length) {
  return Math.ceil(length / 512) * 512;
}

async function tarForDirectory(root, prefix) {
  const chunks = [];
  let totalSize = 0;
  async function addDirectory(directory, relative) {
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (relative) {
      const name = `${prefix}/${relative.replace(/\\/g, '/')}/`;
      chunks.push(tarHeader(name, { mode: 0o755, type: '5' }));
      totalSize += 512;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await addDirectory(absolute, childRelative);
      } else if (entry.isFile()) {
        const contents = await fs.readFile(absolute);
        const isExecutable = entry.name === 'Kusum ERP';
        chunks.push(tarHeader(`${prefix}/${childRelative}`, {
          mode: isExecutable ? 0o755 : 0o644,
          size: contents.length,
          mtime: 0
        }));
        chunks.push(contents);
        const padding = paddedLength(contents.length) - contents.length;
        if (padding) chunks.push(Buffer.alloc(padding));
        totalSize += 512 + paddedLength(contents.length);
      } else if (entry.isSymbolicLink()) {
        const target = await fs.readlink(absolute);
        chunks.push(tarHeader(`${prefix}/${childRelative}`, { mode: 0o777, type: '2' }));
        field(target, 100, 'Tar symlink target').copy(chunks[chunks.length - 1], 157);
        totalSize += 512;
      } else {
        throw new Error(`Unsupported package entry: ${absolute}`);
      }
    }
  }
  await addDirectory(root, '');
  chunks.push(Buffer.alloc(1024));
  totalSize += 1024;
  return { buffer: Buffer.concat(chunks), totalSize };
}

function tarForFiles(files) {
  const chunks = [];
  for (const file of files) {
    const contents = Buffer.isBuffer(file.contents) ? file.contents : Buffer.from(file.contents, 'utf8');
    chunks.push(tarHeader(file.name, {
      mode: file.mode || 0o644,
      size: contents.length,
      mtime: 0
    }));
    chunks.push(contents);
    const padding = paddedLength(contents.length) - contents.length;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function arHeader(name, size) {
  const header = Buffer.alloc(60, 0x20);
  spaceField(`${name}/`, 16, 'Debian archive member').copy(header, 0);
  spaceField('0', 12, 'Debian archive timestamp').copy(header, 16);
  spaceField('0', 6, 'Debian archive owner').copy(header, 28);
  spaceField('0', 6, 'Debian archive group').copy(header, 34);
  spaceField('100644', 8, 'Debian archive mode').copy(header, 40);
  spaceField(String(size), 10, 'Debian archive size').copy(header, 48);
  spaceField('`\n', 2, 'Debian archive terminator').copy(header, 58);
  return header;
}

function buildArArchive(members) {
  const chunks = [Buffer.from('!<arch>\n')];
  for (const member of members) {
    chunks.push(arHeader(member.name, member.contents.length), member.contents);
    if (member.contents.length % 2) chunks.push(Buffer.from('\n'));
  }
  return Buffer.concat(chunks);
}

function packageVersion(packageJson) {
  const version = String(packageJson.version || '').trim();
  if (!/^\d+(?:\.\d+){1,2}(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid Debian package version: ${version || '(empty)'}`);
  }
  return version;
}

async function assertFile(filePath, label) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.size === 0) throw new Error(`${label} is missing or empty: ${filePath}`);
}

async function main() {
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    console.warn(`Building a Debian package from ${process.platform}; use Ubuntu/Debian for the final release.`);
  }
  const arch = architecture(option('--arch', 'x64'));
  const output = outputDirectory();
  if (await fs.stat(output).then(() => true).catch(() => false)) {
    throw new Error(`Build output already exists at ${output}. Choose a new empty folder; this script never overwrites a previous delivery.`);
  }
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  const version = packageVersion(packageJson);
  const staging = path.join(output, '.staging');
  await fs.mkdir(output, { recursive: true });
  try {
    await run(process.execPath, [
      path.join(projectRoot, 'scripts', 'build-electron-linux.mjs'),
      '--arch', arch.electron,
      '--output', staging
    ]);
    const applicationDirectory = path.join(staging, `Kusum ERP-linux-${arch.electron}`);
    await assertFile(path.join(applicationDirectory, 'Kusum ERP'), 'Packaged Linux ERP executable');
    await assertFile(path.join(applicationDirectory, 'resources', 'app', 'package.json'), 'Packaged Linux app manifest');
    await assertFile(path.join(applicationDirectory, 'resources', 'app', 'node_modules', '.prisma', 'client', 'libquery_engine-debian-openssl-3.0.x.so.node'), 'Linux Prisma engine');

    const installedSize = (await (async () => {
      let total = 0;
      async function measure(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const absolute = path.join(directory, entry.name);
          if (entry.isDirectory()) await measure(absolute);
          else if (entry.isFile()) total += (await fs.stat(absolute)).size;
        }
      }
      await measure(applicationDirectory);
      return Math.ceil(total / 1024);
    })());

    const control = `Package: kusum-erp\nVersion: ${version}\nSection: utils\nPriority: optional\nArchitecture: ${arch.debian}\nMaintainer: Kusum ERP <support@kusum.local>\nInstalled-Size: ${installedSize}\nDescription: Kusum ERP jewellery shop management\n Desktop ERP for sales, inventory, schemes, URD, pledges and customer ledgers.\n`;
    const postinst = `#!/bin/sh\nset -e\nchmod 0755 '/opt/kusum-erp/Kusum ERP'\nif command -v update-desktop-database >/dev/null 2>&1; then\n  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true\nfi\nexit 0\n`;
    const desktop = `[Desktop Entry]\nName=Kusum ERP\nComment=Jewellery shop management\nExec="/opt/kusum-erp/Kusum ERP"\nIcon=/opt/kusum-erp/public/kusum-app-icon.png\nTerminal=false\nType=Application\nCategories=Office;Finance;\nStartupWMClass=Kusum ERP\n`;
    const controlTar = await gzip(tarForFiles([
      { name: './control', contents: control },
      { name: './postinst', contents: postinst, mode: 0o755 }
    ]), { level: 9 });
    const applicationTar = (await tarForDirectory(applicationDirectory, 'opt/kusum-erp')).buffer;
    const desktopTar = tarForFiles([{ name: 'usr/share/applications/kusum-erp.desktop', contents: desktop }]);
    // Keep the two zero blocks at the very end of the combined tar stream.
    // Appending entries after an earlier tar terminator would make dpkg stop
    // before it reached the desktop launcher.
    const dataTar = await gzip(Buffer.concat([
      applicationTar.subarray(0, -1024),
      desktopTar.subarray(0, -1024),
      Buffer.alloc(1024)
    ]), { level: 9 });
    const deb = buildArArchive([
      { name: 'debian-binary', contents: Buffer.from('2.0\n') },
      { name: 'control.tar.gz', contents: controlTar },
      { name: 'data.tar.gz', contents: dataTar }
    ]);
    const debName = `kusum-erp_${version}_${arch.debian}.deb`;
    const debPath = path.join(output, debName);
    await fs.writeFile(debPath, deb);
    await fs.writeFile(path.join(output, 'READ-ME-FIRST-DEB.txt'), `Kusum ERP Debian installer\n\nInstall on Ubuntu/Debian ${arch.debian}:\n  sudo apt install ./${debName}\n\nThe installer places the ERP under /opt/kusum-erp and adds a Kusum ERP entry to the application menu.\nInstall MySQL Server on the main database PC and CUPS for USB/shared printers before first setup.\nThe package does not contain shop credentials, .env files, QA data, or test records.\n\nTo remove the application later:\n  sudo apt remove kusum-erp\nThe user's ERP configuration and database are intentionally kept outside the package.\n`, 'utf8');
    const digest = crypto.createHash('sha256').update(deb).digest('hex');
    console.log(`Debian installer created: ${debPath}`);
    console.log(`SHA-256: ${digest}`);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Debian packaging failed: ${error.message || error}`);
  process.exitCode = 1;
});
