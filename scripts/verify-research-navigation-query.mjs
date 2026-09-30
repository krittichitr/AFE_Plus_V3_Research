#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const helperSource = readFileSync(resolve(root, 'src/lib/research/navigationResearchQuery.ts'), 'utf8');
const code = ts.transpileModule(helperSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const module = { exports: {} };
new Function('module', 'exports', code)(module, module.exports);
const { m2ResearchQuerySuffix } = module.exports;

assert.equal(m2ResearchQuerySuffix('1'), '&m2_research=1');
for (const value of [undefined, '0', 'true', '2', ['1'], ['1', '1']]) {
  assert.equal(m2ResearchQuerySuffix(value), '');
}
const location = readFileSync(resolve(root, 'src/pages/location.tsx'), 'utf8');
assert.match(location, /m2ResearchQuerySuffix\(router\.query\.m2_research\)/);
assert.match(location, /\/navigation\?idlocation=/);
assert.match(location, /&users_id=/);
assert.match(location, /&takecare_id=/);
assert.match(location, /&auToken=/);
console.log('PASS: only explicit m2_research=1 reaches Navigation; normal known query remains');

