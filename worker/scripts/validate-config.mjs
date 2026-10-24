#!/usr/bin/env node
/**
 * Fails the build when the names CI passes to wrangler don't match the names
 * declared in wrangler.toml.
 *
 * This exists because of a real outage-by-omission: wrangler.toml was renamed
 * avery-platform -> mogi-platform, the Deploy workflow kept passing the old
 * name to `wrangler d1 migrations apply`, and wrangler answered
 *
 *   ✘ Couldn't find a D1 DB with the name or binding 'avery-platform'
 *
 * That failed the migration step, which *skipped* the deploy step. Every run
 * went red in the same place for weeks and nothing shipped — including a
 * migration adding an index the booking path depends on.
 *
 * A rename is cheap to get wrong and expensive to notice, so the check is
 * mechanical: the workflow declares what it intends to talk to, and this
 * asserts wrangler.toml agrees, with a message that says exactly what to edit.
 *
 * Usage:
 *   node scripts/validate-config.mjs --worker-name <name> --d1-name <name>
 *
 * Both flags are optional; whatever is passed is checked.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRANGLER_TOML = join(dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.toml');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--worker-name' || flag === '--d1-name') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error(`✘ ${flag} requires a value`);
        process.exit(2);
      }
      out[flag === '--worker-name' ? 'workerName' : 'd1Name'] = value;
      i += 1;
    }
  }
  return out;
}

/**
 * Minimal targeted reads rather than a full TOML parse — we need three keys
 * and don't want a dependency. Comment lines are stripped so a commented-out
 * key can't satisfy a check.
 */
function readConfig(text) {
  const live = text
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n');

  const scalarIn = (text, key) => {
    const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'));
    return m ? m[1] : null;
  };

  // Only the top-level `name` counts as the worker name — take it from the
  // text before the first table header so a `name` inside, say, a
  // [[d1_databases]] block can't be mistaken for it.
  const topLevel = live.split(/^\s*\[/m)[0];

  // Collect binding/database_name pairs from [[d1_databases]] blocks only.
  // A bare `binding` sweep would also pick up the KV namespaces, which would
  // let `wrangler d1 migrations apply CACHE` pass validation and then fail
  // for real against Cloudflare.
  const d1Names = [];
  const d1Bindings = [];
  const blocks = live.split(/^\s*\[\[\s*d1_databases\s*\]\]/m).slice(1);
  for (const block of blocks) {
    const body = block.split(/^\s*\[/m)[0];
    const name = scalarIn(body, 'database_name');
    const binding = scalarIn(body, 'binding');
    if (name) d1Names.push(name);
    if (binding) d1Bindings.push(binding);
  }

  return {
    workerName: scalarIn(topLevel, 'name'),
    d1Names,
    d1Bindings,
  };
}

const { workerName, d1Name } = parseArgs(process.argv.slice(2));

let toml;
try {
  toml = readFileSync(WRANGLER_TOML, 'utf8');
} catch (e) {
  console.error(`✘ cannot read ${WRANGLER_TOML}: ${e.message}`);
  process.exit(2);
}

const cfg = readConfig(toml);
const errors = [];

if (workerName) {
  if (!cfg.workerName) {
    errors.push('wrangler.toml declares no top-level `name`.');
  } else if (cfg.workerName !== workerName) {
    errors.push(
      `Worker name mismatch.\n` +
      `    CI passes:        ${workerName}\n` +
      `    wrangler.toml has: ${cfg.workerName}\n` +
      `    Fix WORKER_NAME in .github/workflows/deploy.yml, or \`name\` in worker/wrangler.toml.`,
    );
  }
}

if (d1Name) {
  // `wrangler d1 migrations apply <x>` resolves <x> against either the
  // database_name or the binding of a [[d1_databases]] entry.
  const resolvable = [...cfg.d1Names, ...cfg.d1Bindings];
  if (!resolvable.includes(d1Name)) {
    errors.push(
      `D1 database "${d1Name}" is not declared in wrangler.toml, so\n` +
      `    \`wrangler d1 migrations apply ${d1Name}\` will fail and skip the deploy.\n` +
      `    wrangler.toml declares: ${resolvable.length ? resolvable.join(', ') : '(none)'}\n` +
      `    Fix D1_DATABASE_NAME in .github/workflows/deploy.yml, or the\n` +
      `    database_name/binding in worker/wrangler.toml.`,
    );
  }
}

if (errors.length) {
  console.error('✘ wrangler config validation failed:\n');
  for (const err of errors) console.error(`  - ${err}\n`);
  process.exit(1);
}

const checked = [
  workerName && `worker "${workerName}"`,
  d1Name && `D1 "${d1Name}"`,
].filter(Boolean).join(', ');
console.log(`✓ wrangler config validated${checked ? `: ${checked}` : ''}`);
