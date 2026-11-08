#!/usr/bin/env node
/**
 * The simulation must be deterministic on every peer: packages/core may not use floating-point
 * maths, randomness, clocks, or platform APIs. A cheap textual check (`npm run lint:core`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../packages/core/src/', import.meta.url).pathname;
const RULES = [
  [/\bMath\.(?!imul\b|max\b|min\b|abs\b|trunc\b|sign\b)\w+/, 'Math.* other than imul / max / min / abs / trunc / sign'],
  [/\bDate\b|\bperformance\b/, 'clocks'],
  [/\b(?:window|document|process|require)\b/, 'platform APIs'],
  [/\bFloat(?:32|64)Array\b/, 'float arrays'],
  [/(?<![\w.])\d+\.\d+(?![\w.])/, 'float literal'],
  [/\bfor\s*\([^)]*\bin\b/, 'for..in (property order)'],
];

let bad = 0;
for (const file of readdirSync(ROOT, { recursive: true })) {
  if (!String(file).endsWith('.ts')) continue;
  const lines = readFileSync(join(ROOT, String(file)), 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/'[^']*'|`[^`]*`/g, "''");
    for (const [re, what] of RULES) {
      if (re.test(code)) {
        console.log(`packages/core/src/${file}:${i + 1}: ${what}: ${line.trim()}`);
        bad++;
      }
    }
  });
}
console.log(bad ? `FAIL: ${bad} impure lines in packages/core` : 'PASS: packages/core is free of floats, clocks and randomness');
process.exit(bad ? 1 : 0);
