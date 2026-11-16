import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationDirectory = join(workerRoot, 'drizzle');
const migrationPattern = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

function fail(message) {
  console.error(`Migration validation failed: ${message}`);
  process.exit(1);
}

const files = readdirSync(migrationDirectory).filter(file => file.endsWith('.sql'));
if (files.length === 0) fail('worker/drizzle contains no SQL migrations');

const parsed = files.map(file => {
  const match = migrationPattern.exec(file);
  if (!match) fail(`${file} must match NNNN_lowercase_name.sql`);
  if (readFileSync(join(migrationDirectory, file), 'utf8').trim().length === 0) {
    fail(`${file} is empty`);
  }
  return { file, sequence: Number(match[1]) };
});

const sequences = new Map();
for (const migration of parsed) {
  const existing = sequences.get(migration.sequence);
  if (existing) fail(`${migration.file} reuses sequence ${migration.sequence} from ${existing}`);
  sequences.set(migration.sequence, migration.file);
}

const lexicalOrder = parsed.map(({ file }) => file).sort();
const numericOrder = [...parsed]
  .sort((left, right) => left.sequence - right.sequence)
  .map(({ file }) => file);
if (lexicalOrder.some((file, index) => file !== numericOrder[index])) {
  fail('migration filenames do not sort in numeric application order');
}

const stateDirectory = mkdtempSync(join(tmpdir(), 'mogi-migrations-'));
const wrangler = join(workerRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');

function runWrangler(args) {
  const result = spawnSync(wrangler, args, {
    cwd: workerRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`${args.join(' ')} exited with status ${result.status}\n${output}`);
  }
}

try {
  runWrangler(['d1', 'execute', 'DB', '--local', '--persist-to', stateDirectory, '--file=./schema.sql']);
  runWrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', stateDirectory]);
  runWrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', stateDirectory]);
  console.log(`Validated ${files.length} ordered migrations on a fresh local D1 database.`);
} finally {
  rmSync(stateDirectory, { recursive: true, force: true });
}
