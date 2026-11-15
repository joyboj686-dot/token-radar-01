// Token Launch Radar entry point.
// Reads /input/snapshot.json, writes /output/board.json, /output/data.js, copies dashboard/ and
// screenshots/, and writes /output/dossier.json. Fully deterministic: two runs → byte-identical output.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRadar,
  dataScript,
  parseSnapshot,
  boardIssue,
} from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory>\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// --- Parse and build ---
const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar, backtest } = buildRadar(snapshot);
const issue = boardIssue(board);
if (issue !== null) {
  process.stderr.write(`token radar: model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

// --- Write outputs ---
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), JSON.stringify({ rows: board }) + '\n');
writeFileSync(join(out, 'data.js'), dataScript(radar));

// --- Copy dashboard and screenshots ---
copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} images, need at least 3\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: bad name\n`);
    process.exit(1);
  }
}

// --- Dossier (last, so it reflects the actual /output) ---
writeFileSync(join(out, 'dossier.json'), buildDossier(out, {
  text_max_bytes: TEXT_MAX_BYTES,
  screenshots: SCREENSHOT_CAPS,
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
}));

// --- Summary ---
const compsCount = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0).length;
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} watchlist, ${board.length} rows\n` +
    `token radar: backtest n=${backtest.test_n}, median abs% err=${backtest.median_abs_pct_error}, mean abs% err=${backtest.mean_abs_pct_error}, within-2x=${backtest.within_2x_share}\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, dashboard/ (3 files), screenshots/ (${shots.length} images), dossier.json\n`,
);

// --- Helpers ---

function mkdirdirSync(path: string): void {
  mkdirSync(path, { recursive: true });
}

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(to, name));
    copied.push(name);
  }
  return copied;
}
