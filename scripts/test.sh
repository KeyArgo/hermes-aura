#!/usr/bin/env bash
# Run every tests directory in this repo and write RESULT.txt.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
root="$PWD"
python3 -m venv .venv-test 2>/dev/null || true
py="$root/.venv-test/bin/python"
[[ -x "$py" ]] || py=$(command -v python3)
"$py" -m pip install --quiet --upgrade pip
for f in requirements.txt requirements-dev.txt; do [[ -f $f ]] && "$py" -m pip install --quiet -r $f; done
[[ -f pyproject.toml ]] && "$py" -m pip install --quiet -e . 2>/dev/null
"$py" -m pip install --quiet pytest

mapfile -t suites < <(find . -type d -name tests -not -path "*/.venv*" -not -path "*/node_modules/*" -not -path "*/__pycache__/*" | sort)
overall=0; rows=()
for s in "${suites[@]}"; do
  out=$("$py" -m pytest "$s" -o addopts="" -q -p no:cacheprovider 2>&1); code=$?
  [[ $code -ne 0 && $code -ne 5 ]] && overall=$code
  line=$(printf '%s\n' "$out" | grep -oE '[0-9]+ (passed|failed|error)[^=]*' | tail -1)
  rows+=("${s#./} :: ${line:-exit $code}")
done
{
  echo "plugin:    $(basename "$root")"
  echo "host:      $(uname -srm)"
  echo "python:    $("$py" --version 2>&1)"
  echo "commit:    $(git rev-parse --short HEAD 2>/dev/null)"
  echo "exit:      $overall"
  echo "suites:"
  for r in "${rows[@]}"; do echo "  $r"; done
  echo "run at:    $(date -Iseconds)"
} | tee RESULT.txt
exit $overall
