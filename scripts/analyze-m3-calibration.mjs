#!/usr/bin/env node
// Read-only diagnostics. Never emits an official M3 result or chooses criteria.
import { readFileSync } from 'node:fs';
import { parseJsonl } from './analyze-m3.mjs';
import { summarizeM3Calibration } from './m3-calibration-core.mjs';

export function analyzeCalibrationFiles({ navigationPath, senderPath, manifestPath = null }) {
  const navigationEvents = parseJsonl(readFileSync(navigationPath, 'utf8'));
  const senderEvents = parseJsonl(readFileSync(senderPath, 'utf8'));
  const manifest = manifestPath ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  return summarizeM3Calibration({ navigationEvents, senderEvents, manifest });
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    if (!argv[index].startsWith('--')) continue;
    args[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.navigation || !args.sender) {
    console.error('Usage: node scripts/analyze-m3-calibration.mjs --navigation <nav.jsonl> --sender <sender.jsonl> [--manifest <manifest.json>]');
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(analyzeCalibrationFiles({
      navigationPath: args.navigation,
      senderPath: args.sender,
      manifestPath: args.manifest ?? null,
    }), null, 2));
  }
}
