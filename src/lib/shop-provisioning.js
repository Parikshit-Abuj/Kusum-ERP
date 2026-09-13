const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const mysqlCore = require('mysql2');
const { hashPassword, hasConfiguredPassword, requiredPassword } = require('./auth-security');

// A few early migrations were corrected after release. They work on the
// case-insensitive Windows MySQL installations used by the shop, but their
// corrected SQL must remain compatible with databases that recorded one of
// the known, reviewed historical file checksums. This is deliberately an
// exact allowlist; an unknown changed migration still stops startup.
const LEGACY_MIGRATION_CHECKSUMS = Object.freeze({
  '20260820200000_daily_rates_barcodes_ledger': new Set(['30659da325d2d6ddb6bd2afc79500d2ce5d98b0e0c7452aaeb35c2945ae22ff1']),
  '20260821031245_add_urd_purchase_and_cashbook_sync': new Set(['62a6e77ccf86f6bae7aaf74073ab5c651606d9dd1c800e43cc97a6241c0b7bfc']),
  '20260821090000_sale_urd_settlement_and_cash_sync': new Set(['9498636353ef73e3420f77ce6e02942a88572483d048e97c9fe9ef03738448d7']),
  '20260823093000_add_sale_split_payments': new Set(['78b39e4f0f03d2a676072fd9a39ec5a1fd8a2eada4dafea489dfc1bf7fcbd368'])
});

function migrationChecksumMatches(migrationName, installedChecksum, bundledChecksum) {
  const installed = String(installedChecksum || '').toLowerCase();
  const bundled = String(bundledChecksum || '').toLowerCase();
  return installed === bundled || LEGACY_MIGRATION_CHECKSUMS[migrationName]?.has(installed) === true;
}

function readBundledMigrations(appRoot) {
  const migrationsPath = path.join(appRoot, 'prisma', 'migrations');
  if (!fs.existsSync(migrationsPath) || !fs.statSync(migrationsPath).isDirectory()) {
    throw new Error('ERP installation files are incomplete. The prisma/migrations directory is missing. Re-run the installer.');
  }

  const folders = fs.readdirSync(migrationsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (!folders.length) throw new Error('ERP installation files are incomplete. No database migrations were bundled. Re-run the installer.');

  return folders.map((migrationName) => {
    const sqlPath = path.join(migrationsPath, migrationName, 'migration.sql');
    if (!fs.existsSync(sqlPath) || !fs.statSync(sqlPath).isFile()) {
      throw new Error(`ERP installation files are incomplete: migration ${migrationName} is missing migration.sql. Use an intact ERP release before opening the database.`);
    }
    const sql = fs.readFileSync(sqlPath, 'utf8');
    if (!sql.trim()) {
      throw new Error(`ERP installation files are incomplete: migration ${migrationName} has an empty migration.sql. Use an intact ERP release before opening the database.`);
    }
    return {
      migrationName,
      sql,
      checksum: crypto.createHash('sha256').update(sql).digest('hex')
    };
  });
}

function input(value) {
  return String(value || '').trim();
}

function port(value, label = 'MySQL') {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`Enter a valid ${label} port (1 to 65535).`);
  return parsed;
}

function databaseName(value) {
  const name = input(value);
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new Error('Database name may use only letters, numbers and underscores.');
  return name;
}

function accountName(value, label) {
  const name = input(value);
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(name)) throw new Error(`${label} must be 3 to 64 characters and use only letters, numbers, dots, dashes or underscores.`);
  return name;
}

function databasePassword(value) {
  const password = String(value || '');
  if (!password) throw new Error('Shared ERP database password is required. It is used only by this ERP on the main and client PCs.');
  return password;
}

function mysqlHost(value) {
  const host = input(value);
  if (!host || host.length > 253 || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) {
    throw new Error('Enter a valid MySQL server name or IPv4 address.');
  }
  return host;
}

function isLocalHost(host) {
  return ['localhost', '127.0.0.1'].includes(String(host || '').toLowerCase());
}

function mysqlString(value) {
  return mysqlCore.escape(String(value));
}

function mysqlUrl({ host, port: mysqlPort, username, password, database }) {
  return `mysql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${mysqlPort}/${database}`;
}

function splitMigrationStatements(sql) {
  const statements = [];
  let current = '';
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1] || '';
    if (lineComment) {
      if (char === '\n') { lineComment = false; current += '\n'; }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; current += ' '; index += 1; }
      continue;
    }
    if (quote) {
      current += char;
      if (char === '\\' && index + 1 < sql.length) {
        current += sql[index + 1];
        index += 1;
      } else if (char === quote) {
        if (sql[index + 1] === quote) { current += sql[index + 1]; index += 1; }
        else quote = null;
      }
      continue;
    }
    if (char === '-' && next === '-' && /\s/.test(sql[index + 2] || '')) { lineComment = true; index += 1; continue; }
    if (char === '#') { lineComment = true; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; current += char; continue; }
    if (char === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

async function migrationStatementAlreadyApplied(connection, statement, error) {
  const compact = statement.replace(/\s+/g, ' ').trim();
  const tableMatch = compact.match(/^(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE|CREATE(?: UNIQUE)? INDEX .*? ON)\s+`([^`]+)`/i)
    || compact.match(/^CREATE(?: UNIQUE)? INDEX\s+`[^`]+`\s+ON\s+`([^`]+)`/i);
  const table = tableMatch?.[1];
  if (!table) return false;

  if (error.code === 'ER_TABLE_EXISTS_ERROR' && /^CREATE TABLE/i.test(compact)) {
    const [rows] = await connection.query(
      'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND LOWER(table_name) = LOWER(?) LIMIT 1',
      [table]
    );
    return rows.length === 1;
  }

  if (error.code === 'ER_DUP_FIELDNAME' && /^ALTER TABLE/i.test(compact)) {
    const columns = [...compact.matchAll(/ADD COLUMN\s+`([^`]+)`/gi)].map((match) => match[1]);
    if (!columns.length) return false;
    const [rows] = await connection.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND LOWER(table_name) = LOWER(?)',
      [table]
    );
    const found = new Set(rows.map((row) => String(row.COLUMN_NAME || row.column_name).toLowerCase()));
    // A multi-column ALTER is safe only when every intended column exists.
    return columns.every((column) => found.has(column.toLowerCase()));
  }

  // MySQL DDL is not transactional. If a first-time setup is interrupted
  // immediately after adding a foreign key, the next safe retry must accept
  // that already-created constraint instead of treating the empty setup as a
  // permanently failed migration.
  if (error.code === 'ER_FK_DUP_NAME' && /^ALTER TABLE/i.test(compact)) {
    const constraintMatch = compact.match(/ADD CONSTRAINT\s+`([^`]+)`\s+FOREIGN KEY/i);
    if (!constraintMatch || !table) return false;
    const [rows] = await connection.query(
      'SELECT 1 FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() AND LOWER(table_name) = LOWER(?) AND LOWER(constraint_name) = LOWER(?) LIMIT 1',
      [table, constraintMatch[1]]
    );
    return rows.length === 1;
  }

  if (error.code === 'ER_DUP_KEYNAME') {
    const indexMatch = compact.match(/^CREATE(?: UNIQUE)? INDEX\s+`([^`]+)`/i);
    const index = indexMatch?.[1];
    if (!index) return false;
    const [rows] = await connection.query(
      'SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND LOWER(table_name) = LOWER(?) AND LOWER(index_name) = LOWER(?) LIMIT 1',
      [table, index]
    );
    return rows.length === 1;
  }

  if (error.code === 'ER_FK_DUP_NAME') {
    const constraints = [...compact.matchAll(/ADD CONSTRAINT\s+`([^`]+)`/gi)].map((match) => match[1]);
    if (!constraints.length) return false;
    const [rows] = await connection.query(
      'SELECT constraint_name FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND LOWER(table_name) = LOWER(?) AND constraint_type = \'FOREIGN KEY\'',
      [table]
    );
    const found = new Set(rows.map((row) => String(row.CONSTRAINT_NAME || row.constraint_name).toLowerCase()));
    return constraints.every((constraint) => found.has(constraint.toLowerCase()));
  }

  if (error.code === 'ER_CANT_DROP_FIELD_OR_KEY') {
    const foreignKey = compact.match(/DROP FOREIGN KEY\s+`([^`]+)`/i)?.[1];
    const index = compact.match(/DROP INDEX\s+`([^`]+)`/i)?.[1];
    const objectName = foreignKey || index;
    if (!objectName) return false;
    const source = foreignKey ? 'information_schema.table_constraints' : 'information_schema.statistics';
    const column = foreignKey ? 'constraint_name' : 'index_name';
    const [rows] = await connection.query(
      `SELECT 1 FROM ${source} WHERE table_schema = DATABASE() AND LOWER(table_name) = LOWER(?) AND LOWER(${column}) = LOWER(?) LIMIT 1`,
      [table, objectName]
    );
    return rows.length === 0;
  }

  return false;
}

function printerFormValues(form) {
  const printerMode = String(form.printerMode || 'WINDOWS').trim().toUpperCase() === 'TCP' ? 'TCP' : 'WINDOWS';
  const printerName = input(form.printerName || 'TSC TTP-244 Pro');
  if (printerMode === 'WINDOWS' && !printerName) throw new Error('Enter the installed Windows TSC printer name.');
  const printerHost = input(form.printerHost || '');
  const printerPort = port(form.printerPort || 9100, 'direct TCP printer');
  if (printerMode === 'TCP') mysqlHost(printerHost);
  return { printerMode, printerName, printerHost, printerPort };
}

const REQUIRED_RUNTIME_SCHEMA = {
  AppSession: ['id', 'data', 'expiresAt'],
  BusinessSettings: ['id', 'shopName', 'shopAddress', 'invoicePrefix', 'financialYearStartMonth', 'defaultGstRate', 'defaultHsnCode', 'signatureImage', 'labelWidthMm', 'labelHeightMm'],
  BarcodeSequence: ['prefix', 'lastNumber', 'updatedAt'],
  Customer: ['id', 'name', 'phone', 'panNumber', 'createdAt', 'updatedAt'],
  DailyRate: ['id', 'rateDate', 'gold22k', 'gold24k', 'silver'],
  DocumentSequence: ['key', 'lastNumber', 'updatedAt'],
  ItemName: ['id', 'name', 'category', 'createdAt'],
  Product: ['id', 'barcode', 'sku', 'quantity', 'status', 'batchDocNo', 'makingChargeType', 'makingChargeValue', 'createdAt', 'updatedAt'],
  Sale: ['id', 'invoiceNumber', 'cashPaid', 'upiPaid', 'cardPaid', 'bankPaid', 'balance', 'cancelledAt'],
  SaleItem: ['id', 'saleId', 'productBarcode', 'productName', 'productPurity', 'weight', 'makingChargeType', 'makingChargeValue', 'hsnCode', 'huidCode'],
  SchemePlan: ['id', 'name', 'durationMonths', 'monthlyAmount', 'maturityAmount', 'isActive', 'deletionRequestedAt'],
  SchemeEnrollment: ['id', 'enrollmentNumber', 'schemePlanId', 'customerId', 'startDate', 'endDate', 'status', 'totalPaid', 'installmentsPaid'],
  SchemeInstallment: ['id', 'enrollmentId', 'installmentNumber', 'dueDate', 'paidAmount', 'paymentDate', 'paymentMethod', 'cashbookEntryId', 'status'],
  SchemeInstallmentPayment: ['id', 'installmentId', 'cashbookEntryId', 'amount', 'paymentDate', 'paymentMethod'],
  StockMovement: ['id', 'saleId', 'productId', 'productBarcode', 'type', 'quantity', 'createdAt'],
  CashbookEntry: ['id', 'entryDate', 'paymentMethod', 'customerId', 'saleId', 'urdPurchaseId', 'syncLedger'],
  CustomerLedger: ['id', 'customerId', 'saleId', 'cashbookEntryId', 'amount', 'entryDate'],
  UrdPurchase: ['id', 'purchaseNumber', 'customerId', 'saleId', 'saleOffset', 'paid', 'cancelledAt'],
  UrdPurchaseItem: ['id', 'urdPurchaseId', 'metal', 'purity', 'grossWeight', 'netWeight', 'ratePerGram', 'totalAmount'],
  SyncRevision: ['id', 'revision']
};

async function verifyRuntimeSchema(connection) {
  for (const [table, expectedColumns] of Object.entries(REQUIRED_RUNTIME_SCHEMA)) {
    const [rows] = await connection.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND LOWER(table_name) = LOWER(?)',
      [table]
    );
    if (!rows.length) throw new Error(`Required ERP table ${table} is missing.`);
    const columns = new Set(rows.map((row) => String(row.COLUMN_NAME || row.column_name).toLowerCase()));
    const missing = expectedColumns.filter((column) => !columns.has(column.toLowerCase()));
    if (missing.length) throw new Error(`ERP table ${table} is incomplete (${missing.join(', ')} missing).`);
  }
}

// A first-time setup can be interrupted by a power loss, a Windows restart or
// a temporary MySQL disconnect while DDL is being applied. MySQL DDL is not
// transactional, so the previous attempt can leave an empty, partly-created
// database behind. It is safe to retry only while no shop business record has
// ever been written. Once stock, sales, ledgers, cashbook or URD data exists,
// the ERP deliberately stops and asks for a verified recovery instead.
async function databaseHasBusinessRecords(connection) {
  const [tables] = await connection.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_name IN ('Customer', 'Product', 'Sale', 'SaleItem', 'CustomerLedger', 'CashbookEntry', 'UrdPurchase')`
  );
  for (const row of tables) {
    const table = String(row.TABLE_NAME || row.table_name || '');
    if (!table) continue;
    const [records] = await connection.query(`SELECT 1 FROM ${mysqlCore.escapeId(table)} LIMIT 1`);
    if (records.length) return true;
  }
  return false;
}

async function retireEmptyFailedMigration(connection, migrationName) {
  if (await databaseHasBusinessRecords(connection)) return false;
  await connection.query(
    `UPDATE \`_prisma_migrations\`
     SET \`rolled_back_at\` = NOW(3),
         \`logs\` = CONCAT(COALESCE(\`logs\`, ''), '\\nAutomatically retried during empty first-time setup.')
     WHERE \`migration_name\` = ? AND \`finished_at\` IS NULL AND \`rolled_back_at\` IS NULL`,
    [migrationName]
  );
  return true;
}

function connectionValues({ host, mysqlPort, database, username, password, appUsername, appPassword, printerMode, printerName, printerHost, printerPort, mode }) {
  return {
    DATABASE_URL: mysqlUrl({ host, port: mysqlPort, username, password, database }),
    PORT: 3000,
    AUTH_USERNAME: appUsername,
    AUTH_PASSWORD_HASH: hashPassword(appPassword),
    SESSION_SECRET: process.env.SESSION_SECRET || crypto.randomBytes(48).toString('base64url'),
    TSC_PRINTER_MODE: printerMode,
    TSC_PRINTER_NAME: printerName,
    TSC_PRINTER_HOST: printerHost,
    TSC_PRINTER_PORT: printerPort,
    KUSUM_DEPLOYMENT_MODE: mode
  };
}

async function runBundledMigrations(appRoot, databaseUrl) {
  const migrations = readBundledMigrations(appRoot);

  const connection = await mysql.createConnection({ uri: databaseUrl, multipleStatements: true, connectTimeout: 12000 });
  let migrationLockHeld = false;
  try {
    // Prevent two local ERP starts or two setup clicks from applying the same
    // schema at once. GET_LOCK is scoped to this MySQL connection and is
    // released automatically if that connection is lost.
    const [lockRows] = await connection.query(
      "SELECT GET_LOCK(CONCAT('kusum-erp-schema:', DATABASE()), 45) AS acquired"
    );
    if (Number(lockRows?.[0]?.acquired) !== 1) {
      throw new Error('Another ERP setup or schema update is still running. Wait one minute, then try again.');
    }
    migrationLockHeld = true;
    await connection.query(`CREATE TABLE IF NOT EXISTS \`_prisma_migrations\` (
      \`id\` VARCHAR(36) NOT NULL,
      \`checksum\` VARCHAR(64) NOT NULL,
      \`finished_at\` DATETIME(3) NULL,
      \`migration_name\` VARCHAR(255) NOT NULL,
      \`logs\` TEXT NULL,
      \`rolled_back_at\` DATETIME(3) NULL,
      \`started_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      \`applied_steps_count\` INTEGER UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (\`id\`)
    ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    for (const { migrationName, sql, checksum } of migrations) {
      const [applied] = await connection.query(
        'SELECT `id`, `checksum`, `finished_at`, `rolled_back_at` FROM `_prisma_migrations` WHERE `migration_name` = ? ORDER BY `started_at` DESC',
        [migrationName]
      );
      const completed = applied.find((row) => row.finished_at && !row.rolled_back_at);
      if (completed) {
        if (!migrationChecksumMatches(migrationName, completed.checksum, checksum)) {
          throw new Error(`Bundled migration ${migrationName} was changed after it was installed. Use an intact ERP release before opening the shop database.`);
        }
        continue;
      }
      if (applied.some((row) => !row.finished_at && !row.rolled_back_at)) {
        const retried = await retireEmptyFailedMigration(connection, migrationName);
        if (!retried) {
          throw new Error(`Migration ${migrationName} has an unfinished earlier attempt. Do not continue billing until the database migration is repaired from a verified backup.`);
        }
      }

      const migrationId = crypto.randomUUID();
      await connection.query(
        'INSERT INTO `_prisma_migrations` (`id`, `checksum`, `migration_name`, `started_at`, `applied_steps_count`) VALUES (?, ?, ?, NOW(3), 0)',
        [migrationId, checksum, migrationName]
      );
      try {
        let appliedSteps = 0;
        for (const statement of splitMigrationStatements(sql)) {
          try {
            await connection.query(statement);
          } catch (error) {
            const safeExistingEffect = await migrationStatementAlreadyApplied(connection, statement, error);
            if (!safeExistingEffect) throw error;
          }
          appliedSteps += 1;
        }
        await connection.query(
          'UPDATE `_prisma_migrations` SET `finished_at` = NOW(3), `applied_steps_count` = ? WHERE `id` = ?',
          [appliedSteps, migrationId]
        );
      } catch (error) {
        await connection.query('UPDATE `_prisma_migrations` SET `logs` = ? WHERE `id` = ?', [String(error.message || error).slice(0, 65535), migrationId]);
        throw error;
      }
    }
    await verifyRuntimeSchema(connection);
  } catch (error) {
    throw new Error(`Could not apply the ERP database schema: ${error.message || error}`);
  } finally {
    if (migrationLockHeld) {
      await connection.query("DO RELEASE_LOCK(CONCAT('kusum-erp-schema:', DATABASE()))").catch(() => {});
    }
    await connection.end();
  }
}

function writeEnvFile(configPath, values) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const content = [
    '# Created by Kusum Jewelers ERP shop setup. The MySQL administrator password is never saved here.',
    ...Object.entries(values).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
  ].join('\r\n') + '\r\n';
  const temporary = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, configPath);
}

function commonFormValues(form) {
  return {
    host: mysqlHost(form.mysqlHost),
    mysqlPort: port(form.mysqlPort || 3306),
    database: databaseName(form.databaseName || 'kusum_erp'),
    databaseUser: accountName(form.databaseUser || 'kusum_erp_shared', 'Shared ERP database username'),
    databasePassword: databasePassword(form.databasePassword),
    appUsername: accountName(form.appUsername || 'kusum', 'ERP login username'),
    appPassword: requiredPassword(form.appPassword, 'ERP login password'),
    ...printerFormValues(form)
  };
}

async function grantDatabaseAccess(connection, { database, username, password, includeNetwork }) {
  const hosts = includeNetwork ? ['localhost', '127.0.0.1', '%'] : ['localhost', '127.0.0.1'];
  for (const accountHost of hosts) {
    await connection.query(`CREATE USER IF NOT EXISTS ${mysqlString(username)}@${mysqlString(accountHost)} IDENTIFIED BY ${mysqlString(password)}`);
    await connection.query(`ALTER USER ${mysqlString(username)}@${mysqlString(accountHost)} IDENTIFIED BY ${mysqlString(password)}`);
    // This account is limited to the ERP database. The main PC firewall keeps
    // the database port reachable only from the private shop network.
    await connection.query(`GRANT ALL PRIVILEGES ON ${mysqlCore.escapeId(database)}.* TO ${mysqlString(username)}@${mysqlString(accountHost)}`);
  }
  await connection.query('FLUSH PRIVILEGES');
}

async function verifyClientConnection(databaseUrl, appRoot) {
  let connection;
  try {
    const bundled = appRoot
      ? readBundledMigrations(appRoot).map(({ migrationName, checksum }) => ({ name: migrationName, checksum }))
      : null;
    connection = await mysql.createConnection({ uri: databaseUrl, connectTimeout: 12000 });
    const requiredTables = ['_prisma_migrations', ...Object.keys(REQUIRED_RUNTIME_SCHEMA)];
    const [tables] = await connection.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (?)',
      [requiredTables]
    );
    const found = new Set(tables.map((row) => String(row.TABLE_NAME || row.table_name).toLowerCase()));
    const missing = requiredTables.filter((table) => !found.has(table.toLowerCase()));
    if (missing.length) throw new Error(`The selected database is not fully initialized (${missing.join(', ')} missing). Complete or update Main database PC setup first.`);
    await verifyRuntimeSchema(connection);
    if (bundled) {
      const [installed] = await connection.query(
        'SELECT `migration_name`, `checksum` FROM `_prisma_migrations` WHERE `finished_at` IS NOT NULL AND `rolled_back_at` IS NULL'
      );
      const installedByName = new Map(installed.map((row) => [row.migration_name, String(row.checksum || '').toLowerCase()]));
      const missingMigrations = bundled.filter((migration) => !installedByName.has(migration.name));
      if (missingMigrations.length) throw new Error('The main database PC is using an older ERP schema. Update and start the ERP on the main PC before connecting this client.');
      const changedMigration = bundled.find((migration) => !migrationChecksumMatches(
        migration.name,
        installedByName.get(migration.name),
        migration.checksum
      ));
      if (changedMigration) throw new Error(`The main database migration ${changedMigration.name} does not match this ERP release. Use the same intact release on every PC.`);
    }
  } catch (error) {
    throw new Error(`Could not connect to the main ERP database: ${error.message || error}`);
  } finally {
    if (connection) await connection.end();
  }
}

function parseDatabaseConnection(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    if (url.protocol !== 'mysql:') throw new Error('Unsupported database URL.');
    return {
      host: url.hostname,
      port: port(url.port || 3306),
      database: databaseName(decodeURIComponent(url.pathname.replace(/^\//, ''))),
      username: decodeURIComponent(url.username || ''),
      password: decodeURIComponent(url.password || '')
    };
  } catch (error) {
    throw new Error(`Could not read the existing ERP database connection: ${error.message || error}`);
  }
}

async function provisionMainDatabase({ appRoot, configPath, form }) {
  const values = commonFormValues(form);
  if (!isLocalHost(values.host)) throw new Error('Main database PC setup must use localhost or 127.0.0.1. Client PCs will use this PC’s LAN address.');
  const rootUser = input(form.mysqlUser || 'root');
  if (!rootUser) throw new Error('Enter the MySQL administrator username.');
  const rootPassword = String(form.mysqlPassword || '');
  let rootConnection;
  try {
    rootConnection = await mysql.createConnection({ host: values.host, port: values.mysqlPort, user: rootUser, password: rootPassword, connectTimeout: 12000 });
    await rootConnection.query(`CREATE DATABASE IF NOT EXISTS ${mysqlCore.escapeId(values.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await grantDatabaseAccess(rootConnection, {
      database: values.database,
      username: values.databaseUser,
      password: values.databasePassword,
      includeNetwork: true
    });
  } finally {
    if (rootConnection) await rootConnection.end();
  }

  const config = connectionValues({ ...values, username: values.databaseUser, password: values.databasePassword, mode: 'SERVER' });
  await runBundledMigrations(appRoot, config.DATABASE_URL);
  writeEnvFile(configPath, config);
  return config;
}

async function provisionClientDatabase({ appRoot, configPath, form }) {
  const values = commonFormValues(form);
  if (isLocalHost(values.host)) throw new Error('Client PC setup must use the Main database PC LAN IP address, not localhost or 127.0.0.1.');
  const config = connectionValues({ ...values, username: values.databaseUser, password: values.databasePassword, mode: 'CLIENT' });
  await verifyClientConnection(config.DATABASE_URL, appRoot);
  writeEnvFile(configPath, config);
  return config;
}

async function provisionShopDatabase({ appRoot, configPath, form }) {
  if (input(form.setupMode).toUpperCase() === 'CLIENT') return provisionClientDatabase({ appRoot, configPath, form });
  return provisionMainDatabase({ appRoot, configPath, form });
}

async function enableNetworkSharing({ databaseUrl, configPath, currentEnv, form }) {
  const current = parseDatabaseConnection(databaseUrl);
  if (!isLocalHost(current.host)) throw new Error('This ERP is already configured as a client PC. Enable sharing only on the main database PC.');
  const rootUser = input(form.mysqlUser || 'root');
  if (!rootUser) throw new Error('Enter the MySQL administrator username.');
  const databaseUser = accountName(form.databaseUser || 'kusum_erp_shared', 'Shared ERP database username');
  const password = databasePassword(form.databasePassword);
  let rootConnection;
  try {
    rootConnection = await mysql.createConnection({ host: current.host, port: current.port, user: rootUser, password: String(form.mysqlPassword || ''), connectTimeout: 12000 });
    await grantDatabaseAccess(rootConnection, { database: current.database, username: databaseUser, password, includeNetwork: true });
  } catch (error) {
    throw new Error(`Could not enable client PC access: ${error.message || error}`);
  } finally {
    if (rootConnection) await rootConnection.end();
  }
  let updatedConfig = null;
  if (current.username === databaseUser) {
    updatedConfig = {
      DATABASE_URL: mysqlUrl({ host: current.host, port: current.port, username: databaseUser, password, database: current.database }),
      PORT: currentEnv.PORT || 3000,
      AUTH_USERNAME: currentEnv.AUTH_USERNAME,
      ...(currentEnv.AUTH_PASSWORD_HASH
        ? { AUTH_PASSWORD_HASH: currentEnv.AUTH_PASSWORD_HASH }
        : { AUTH_PASSWORD: currentEnv.AUTH_PASSWORD }),
      SESSION_SECRET: currentEnv.SESSION_SECRET || crypto.randomBytes(48).toString('base64url'),
      TSC_PRINTER_MODE: currentEnv.TSC_PRINTER_MODE || 'WINDOWS',
      TSC_PRINTER_NAME: currentEnv.TSC_PRINTER_NAME || 'TSC TTP-244 Pro',
      TSC_PRINTER_HOST: currentEnv.TSC_PRINTER_HOST || '',
      TSC_PRINTER_PORT: currentEnv.TSC_PRINTER_PORT || 9100,
      KUSUM_DEPLOYMENT_MODE: currentEnv.KUSUM_DEPLOYMENT_MODE || 'SERVER'
    };
    writeEnvFile(configPath, updatedConfig);
  }
  return { database: current.database, port: current.port, username: databaseUser, updatedConfig };
}

function updatePrinterConfiguration({ configPath, currentEnv, form }) {
  if (!currentEnv.DATABASE_URL || !currentEnv.AUTH_USERNAME || !hasConfiguredPassword(currentEnv)) {
    throw new Error('Save a working ERP database connection before configuring the printer.');
  }
  const printer = printerFormValues(form);
  const config = {
    DATABASE_URL: currentEnv.DATABASE_URL,
    PORT: currentEnv.PORT || 3000,
    AUTH_USERNAME: currentEnv.AUTH_USERNAME,
    ...(currentEnv.AUTH_PASSWORD_HASH
      ? { AUTH_PASSWORD_HASH: currentEnv.AUTH_PASSWORD_HASH }
      : { AUTH_PASSWORD: currentEnv.AUTH_PASSWORD }),
    SESSION_SECRET: currentEnv.SESSION_SECRET || crypto.randomBytes(48).toString('base64url'),
    TSC_PRINTER_MODE: printer.printerMode,
    TSC_PRINTER_NAME: printer.printerName,
    TSC_PRINTER_HOST: printer.printerHost,
    TSC_PRINTER_PORT: printer.printerPort,
    KUSUM_DEPLOYMENT_MODE: currentEnv.KUSUM_DEPLOYMENT_MODE || 'SERVER'
  };
  writeEnvFile(configPath, config);
  return config;
}

function updateLoginConfiguration({ configPath, currentEnv, username, password }) {
  if (!currentEnv.DATABASE_URL) throw new Error('Save a working ERP database connection before changing the login.');
  const appUsername = accountName(username || currentEnv.AUTH_USERNAME || 'kusum', 'ERP login username');
  const appPassword = requiredPassword(password, 'ERP login password');
  const config = {
    DATABASE_URL: currentEnv.DATABASE_URL,
    PORT: currentEnv.PORT || 3000,
    AUTH_USERNAME: appUsername,
    AUTH_PASSWORD_HASH: hashPassword(appPassword),
    SESSION_SECRET: currentEnv.SESSION_SECRET || crypto.randomBytes(48).toString('base64url'),
    TSC_PRINTER_MODE: currentEnv.TSC_PRINTER_MODE || 'WINDOWS',
    TSC_PRINTER_NAME: currentEnv.TSC_PRINTER_NAME || 'TSC TTP-244 Pro',
    TSC_PRINTER_HOST: currentEnv.TSC_PRINTER_HOST || '',
    TSC_PRINTER_PORT: currentEnv.TSC_PRINTER_PORT || 9100,
    KUSUM_DEPLOYMENT_MODE: currentEnv.KUSUM_DEPLOYMENT_MODE || 'SERVER'
  };
  writeEnvFile(configPath, config);
  return config;
}

module.exports = { provisionShopDatabase, enableNetworkSharing, updatePrinterConfiguration, updateLoginConfiguration, parseDatabaseConnection, isLocalHost, runBundledMigrations, verifyClientConnection, migrationChecksumMatches };
