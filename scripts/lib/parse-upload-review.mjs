#!/usr/bin/env node
// Validates a steward-upload review file and prints the Trino SQL fragments
// scripts/review-upload.sh needs, one per line, in a fixed order. Kept
// separate from the shell script because building SQL fragments by string
// concatenation in POSIX sh, safely, is not realistic -- Node's JSON.parse
// plus a couple of regexes does the same job the rest of this repo already
// trusts for identifiers (config/nifi/scripts/load_csv_into_iceberg.groovy's
// own `quoted` helper takes the same "regex-validate, then double-quote, no
// further escaping" approach).
//
// Usage: node parse-upload-review.mjs <review.json path> <org_unit>
// Exits non-zero with a message on stderr for any validation failure; never
// interpolates a value into SQL that has not first matched an allow-list.

import { readFileSync } from 'node:fs';

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const ORG_UNIT = /^[a-z0-9_-]+$/;
const ALLOWED_TYPES = new Set(['VARCHAR', 'BIGINT', 'INTEGER', 'DOUBLE', 'BOOLEAN', 'DATE', 'TIMESTAMP']);
const ALLOWED_CLASSIFICATIONS = new Set(['public', 'internal', 'sensitive']);

function fail(message) {
  console.error(`parse-upload-review: ${message}`);
  process.exit(1);
}

const [, , reviewPath, orgUnit] = process.argv;
if (!reviewPath || !orgUnit) {
  fail('usage: parse-upload-review.mjs <review.json> <org_unit>');
}
if (!ORG_UNIT.test(orgUnit)) {
  fail(`org_unit ${JSON.stringify(orgUnit)} has an unexpected shape`);
}

let review;
try {
  review = JSON.parse(readFileSync(reviewPath, 'utf8'));
} catch (error) {
  fail(`could not read/parse ${reviewPath}: ${error.message}`);
}

const reviewer = typeof review.reviewer === 'string' ? review.reviewer.trim() : '';
if (!reviewer) {
  fail('"reviewer" is required');
}

const tableSuffix = typeof review.table_suffix === 'string' ? review.table_suffix : '';
if (!IDENTIFIER.test(tableSuffix)) {
  fail(`"table_suffix" ${JSON.stringify(tableSuffix)} must match ${IDENTIFIER}`);
}

if (!Array.isArray(review.columns) || review.columns.length === 0) {
  fail('"columns" must be a non-empty array');
}

const seenNames = new Set();
const columns = review.columns.map((column, index) => {
  const name = typeof column?.name === 'string' ? column.name : '';
  const type = typeof column?.type === 'string' ? column.type : '';
  const classification = typeof column?.classification === 'string' ? column.classification : '';

  if (!IDENTIFIER.test(name)) {
    fail(`columns[${index}].name ${JSON.stringify(name)} must match ${IDENTIFIER}`);
  }
  if (seenNames.has(name)) {
    fail(`columns[${index}].name ${JSON.stringify(name)} is duplicated`);
  }
  seenNames.add(name);
  if (!ALLOWED_TYPES.has(type)) {
    fail(`columns[${index}].type ${JSON.stringify(type)} must be one of ${[...ALLOWED_TYPES].join(', ')}`);
  }
  if (!ALLOWED_CLASSIFICATIONS.has(classification)) {
    fail(
      `columns[${index}].classification ${JSON.stringify(classification)} must be one of ${[...ALLOWED_CLASSIFICATIONS].join(', ')}`,
    );
  }
  return { name, type, classification };
});

const publicColumns = columns.filter((column) => column.classification === 'public');
if (publicColumns.length === 0) {
  fail('no column is classified "public" -- there is nothing safe to load, refusing rather than loading an empty table');
}

const quote = (name) => `"${name}"`;

const targetTable = `steward_${orgUnit}_${tableSuffix}`;
const stagingColumnsSql = columns.map((column) => `${quote(column.name)} VARCHAR`).join(', ');
const targetColumnsSql = publicColumns.map((column) => `${quote(column.name)} ${column.type}`).join(', ');
const insertColumnsSql = publicColumns.map((column) => quote(column.name)).join(', ');
const selectListSql = publicColumns
  .map((column) => `CAST(NULLIF(${quote(column.name)}, '') AS ${column.type})`)
  .join(', ');

process.stdout.write(
  [
    targetTable,
    stagingColumnsSql,
    targetColumnsSql,
    insertColumnsSql,
    selectListSql,
    String(publicColumns.length),
    String(columns.length - publicColumns.length),
    reviewer,
  ].join('\n') + '\n',
);
