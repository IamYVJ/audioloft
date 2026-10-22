// Regression check for sw.js. Run with `node scripts/check-sw.mjs`.
//
// The GoatCounter beacon must never be cached: a beacon answered from cache
// records nothing. The worker only handles same-origin requests, so it must
// never name the analytics hosts (comments are ignored).
import { readFileSync } from 'node:fs';

const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
let failed = 0;

function ok(condition, message) {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
    if (!condition) failed++;
}

ok(!/gc\.zgo\.at|goatcounter/.test(sw.replace(/\/\/[^\n]*/g, '')),
    'the analytics beacon is not routed or precached by the worker');
ok(/origin !== self\.location\.origin\) return;/.test(sw),
    'the fetch handler ignores cross-origin requests');

process.exitCode = failed ? 1 : 0;
