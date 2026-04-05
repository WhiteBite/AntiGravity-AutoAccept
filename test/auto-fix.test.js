/**
 * Auto-Fix Test Suite
 * ─────────────────────────────────
 * Tests the PowerShell regex logic to ensure we don't accidentally
 * concatenate ports like 96609666 when editing shortcuts.
 *
 * Run:  node test/auto-fix.test.js
 */

const assert = require('assert');
const cp = require('child_process');

let pass = 0, fail = 0;
const fails = [];

function test(name, fn) {
    try { fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
    catch (e) { fail++; fails.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

function eq(actual, expected) { assert.strictEqual(actual, expected); }

function runPsReplace(inputArgs, flag) {
    // Ensure escape sequences are valid for the child process execution.
    // The PowerShell script tests the exact conditionals we put into extension.js
    const script = `
        $args_str = '${inputArgs}'
        $flag = '${flag}'
        if ($args_str -match '--remote-debugging-port=\\d+') {
            $args_str -replace '--remote-debugging-port=\\d+', $flag
        } elseif ($args_str -match '--remote-debugging-port=(?!\\d)') {
            $args_str -replace '--remote-debugging-port=(?!\\d)', $flag
        } else {
            ($args_str + ' ' + $flag).Trim()
        }
    `.trim().replace(/\n/g, ';');
    
    return cp.execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "& { ${script} }"`, { stdio: 'pipe' }).toString().trim();
}

console.log('\n\x1b[1m--- PowerShell Regex Port Replacement ---\x1b[0m');

if (process.platform !== 'win32') {
    console.log('  \x1b[33m⚠\x1b[0m Skipping platform-specific PowerShell tests on non-Windows');
    process.exit(0);
}

// 1. Missing port value (--remote-debugging-port=) -> should replace and not append
test('Handles empty port value (--remote-debugging-port=)', () => {
    const res = runPsReplace('--remote-debugging-port=', '--remote-debugging-port=9660');
    eq(res, '--remote-debugging-port=9660');
});

// 2. Existing valid port (--remote-debugging-port=9222) -> should replace completely
test('Replaces existing numeric port entirely', () => {
    const res = runPsReplace('--remote-debugging-port=9222', '--remote-debugging-port=9660');
    eq(res, '--remote-debugging-port=9660');
});

// 3. Existing duplicated/appended BAD port like 96609666 -> should replace entirely
test('Replaces corrupted large numeric port entirely', () => {
    const res = runPsReplace('--remote-debugging-port=96609666', '--remote-debugging-port=9660');
    eq(res, '--remote-debugging-port=9660');
});

// 4. Missing flag entirely -> should append space + new flag
test('Appends flag if entirely missing', () => {
    const res = runPsReplace('--enable-sandbox', '--remote-debugging-port=9660');
    eq(res, '--enable-sandbox --remote-debugging-port=9660');
});

// 5. Existing port with other flags after it -> should replace safely
test('Replaces port correctly even with trailing flags', () => {
    const res = runPsReplace('--remote-debugging-port=9333 --enable-sandbox', '--remote-debugging-port=9660');
    eq(res, '--remote-debugging-port=9660 --enable-sandbox');
});

console.log(`\n${'═'.repeat(50)}`);
console.log(`  \x1b[32m${pass} passed\x1b[0m, \x1b[${fail ? '31' : '32'}m${fail} failed\x1b[0m, ${pass + fail} total`);

if (fails.length) {
    console.log('\n  Failures:');
    fails.forEach(f => console.log(`   • ${f}`));
}
console.log('');
process.exit(fail ? 1 : 0);
