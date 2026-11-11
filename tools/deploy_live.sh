#!/usr/bin/env bash
# Deploy the repo to the live install, stamping the build it actually is.
#
# The chip reads BUILD_INFO.json, which is generated — so it must be written at
# deploy time from the repo's HEAD, never left over from an earlier run. Both
# desktop copies are updated: the app executes ~/.hermes/desktop-plugins/<id>/.
set -euo pipefail

REPO="${1:-/mnt/homes/Development/hermes-aura}"
PLUGIN="$HOME/.hermes/plugins/aura"
APP="$HOME/.hermes/desktop-plugins/aura"

cd "$REPO"
python3 tools/stamp_build.py >/dev/null

cp desktop/plugin.js "$PLUGIN/desktop/plugin.js"
cp desktop/plugin.js "$APP/plugin.js"
[ -f web/player.html ] && cp web/player.html "$PLUGIN/web/player.html"
[ -f web/aura.js ] && cp web/aura.js "$PLUGIN/web/aura.js"
[ -f dashboard/plugin_api.py ] && cp dashboard/plugin_api.py "$PLUGIN/dashboard/plugin_api.py"
[ -f plugin.yaml ] && cp plugin.yaml "$PLUGIN/plugin.yaml"
cp BUILD_INFO.json "$PLUGIN/BUILD_INFO.json"
cp BUILD_INFO.json "$APP/BUILD_INFO.json"

python3 - "$PLUGIN/BUILD_INFO.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print("chip:", "v%s · %s · %s%s" % (d["version"], d["commit_date"][:10],
                                    d.get("commit_short") or d["commit"][:8],
                                    " · modified" if d.get("dirty") else ""))
PY
echo "synced: $PLUGIN and $APP (quit Hermes fully to load the desktop half)"
