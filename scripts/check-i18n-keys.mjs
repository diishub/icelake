/*
 * Checks that every translation key the portal asks for exists in every
 * language file. Run from scripts/test-portal-i18n.sh, which sets the working
 * directory to portal/.
 *
 * Lives outside portal/ on purpose: that folder is the nginx web root, so
 * anything placed in it is served to every visitor.
 */
import fs from "node:fs";

const html = fs.readFileSync("index.html", "utf8");
const app = fs.readFileSync("app.js", "utf8");

const used = new Set();
for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) {
  used.add(match[1]);
}
for (const match of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
  for (const pair of match[1].split(",")) {
    used.add(pair.split(":")[1].trim());
  }
}
for (const match of app.matchAll(/\bt\("([^"]+)"/g)) {
  used.add(match[1]);
}

// Keys the code builds at run time from a template literal, which the scan
// above cannot see. Listed here so they are still covered.
for (const role of ["viewer", "analyst", "steward", "operator"]) {
  for (const part of ["label", "title", "description", "step1", "step2", "step3"]) {
    used.add(`role.${role}.${part}`);
  }
}
for (const role of ["viewer", "analyst", "steward"]) {
  used.add(`role.${role}.action`);
  used.add(`role.${role}.footnote`);
}
for (const key of [
  "role.operator.actionLocal", "role.operator.actionRemote",
  "role.operator.footnoteLocal", "role.operator.footnoteRemote",
  "availability.published", "availability.withheld",
  "availability.pending", "availability.retired",
  "loadMode.full_refresh", "loadMode.incremental",
  "userType.student", "userType.staff", "userType.unknown",
]) {
  used.add(key);
}

// Derived from the folder, so a new language is covered the moment its file
// lands rather than when someone remembers to add it here.
const languages = fs.readdirSync("i18n")
  .filter((name) => name.endsWith(".js") && name !== "index.js")
  .map((name) => name.replace(/\.js$/, ""));

let failed = 0;

if (languages.length < 2) {
  failed += 1;
  console.error(`FAIL only ${languages.length} language file(s) found in portal/i18n`);
}

const defined = new Map();
for (const language of languages) {
  const text = fs.readFileSync(`i18n/${language}.js`, "utf8");
  const keys = new Set();
  for (const match of text.matchAll(/^ {2}"([^"]+)":/gm)) {
    keys.add(match[1]);
  }
  defined.set(language, keys);
}

for (const language of languages) {
  const missing = [...used].filter((key) => !defined.get(language).has(key));
  if (missing.length === 0) {
    console.log(`PASS every string the page asks for resolves in ${language} (${used.size} keys)`);
  } else {
    failed += 1;
    console.error(
      `FAIL ${missing.length} string(s) missing in ${language}: ${missing.slice(0, 8).join(", ")}`);
  }
}

// A key present in one language and absent from another is the same defect
// read from the other direction, and it is the one a scan of usage misses.
const [first, ...rest] = languages;
for (const language of rest) {
  const onlyHere = [...defined.get(first)].filter((key) => !defined.get(language).has(key));
  const onlyThere = [...defined.get(language)].filter((key) => !defined.get(first).has(key));
  if (onlyHere.length === 0 && onlyThere.length === 0) {
    console.log(`PASS ${first} and ${language} declare the same keys`);
  } else {
    failed += 1;
    console.error(
      `FAIL ${first}/${language} differ: ${[...onlyHere, ...onlyThere].slice(0, 8).join(", ")}`);
  }
}

process.exit(failed === 0 ? 0 : 1);
