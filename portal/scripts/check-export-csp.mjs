/*
 * Fails the build if the static export would break the portal's CSP
 * (config/portal/default.conf.template: `script-src 'self'; style-src 'self'`):
 *   - an executable inline <script> (only type="application/json" may be inline)
 *   - an inline <style> block or a style="" attribute
 *
 * Turbopack's production build injects an inline bootstrap script, which is
 * why `npm run build` uses webpack. This check is what notices if that, or a
 * stray style prop in a component, ever comes back.
 */
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve('out');
const problems = [];

function* htmlFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(full);
    else if (entry.name.endsWith('.html')) yield full;
  }
}

for (const file of htmlFiles(outDir)) {
  const html = fs.readFileSync(file, 'utf8');
  const name = path.relative(outDir, file);
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const [, attributes, body] = match;
    const isJson = /\btype="application\/json"/.test(attributes);
    if (body.trim() && !isJson) {
      problems.push(`${name}: inline <script> (${body.trim().slice(0, 60)}...)`);
    }
  }
  if (/<style\b/.test(html)) problems.push(`${name}: inline <style> block`);
  if (/\sstyle="/.test(html)) problems.push(`${name}: style="" attribute`);
}

if (problems.length) {
  console.error('The export would be blocked by the portal CSP:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log('CSP check passed: no inline script or style in out/');
