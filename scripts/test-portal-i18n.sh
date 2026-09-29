#!/bin/sh
# Assert the portal is actually multilingual rather than mostly multilingual.
#
# The failure this guards against is the quiet one: a string that was never
# given a translation, which shows up as a single foreign line in the middle of
# a page and is easy to miss in review. Every key the markup and the script ask
# for has to exist in every file under portal/i18n, and every font the
# stylesheet references has to be on disk.
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "${repo_dir}/portal"

failures=0
pass() { echo "PASS $1"; }
fail() { failures=$((failures + 1)); echo "FAIL $1" >&2; }

# --- Every referenced font file exists -------------------------------------
missing_fonts=""
for font in $(grep -oE '/fonts/[a-z0-9.-]+\.woff2' styles.css | sort -u); do
  [ -f ".${font}" ] || missing_fonts="${missing_fonts} ${font}"
done
if [ -z "${missing_fonts}" ]; then
  pass "every font the stylesheet references is vendored"
else
  fail "missing font files:${missing_fonts}"
fi

# The reverse direction matters too: a font left behind after a change is dead
# weight that still ships.
orphan_fonts=""
for file in fonts/*.woff2; do
  grep -q "/${file}" styles.css || orphan_fonts="${orphan_fonts} ${file}"
done
if [ -z "${orphan_fonts}" ]; then
  pass "no vendored font is unreferenced"
else
  fail "unreferenced font files:${orphan_fonts}"
fi

# --- Every language file is actually loaded --------------------------------
unloaded=""
for file in i18n/*.js; do
  grep -q "\"/${file}\"" index.html || unloaded="${unloaded} ${file}"
done
if [ -z "${unloaded}" ]; then
  pass "every language file has a script tag"
else
  fail "language files never loaded by the page:${unloaded}"
fi

# --- Every key resolves in every language ----------------------------------
# A relative path on purpose: an absolute POSIX path is handed to node.exe
# unconverted when MSYS_NO_PATHCONV is set, which the rest of this repo sets
# for docker compose. Relative paths are passed through untouched.
node ../scripts/check-i18n-keys.mjs || failures=$((failures + 1))

# --- The catalogue carries translated names --------------------------------
if [ -f data/catalog.json ]; then
  if grep -q '"title_en"' data/catalog.json && grep -q '"label_en"' data/catalog.json; then
    pass "the published catalogue carries English names"
  else
    fail "the published catalogue has no English names; re-run scripts/publish-portal-catalog.sh"
  fi
else
  echo "SKIP catalogue not published on this machine"
fi

if [ "${failures}" -eq 0 ]; then
  echo "all portal language cases passed"
else
  echo "${failures} case(s) failed" >&2
  exit 1
fi
