#!/usr/bin/env bash
# install-statusline.sh — Idempotent installer for the anti-hall statusline.
#
# Sets statusLine in ~/.claude/settings.json to invoke statusline.sh.
# Backs up settings.json to settings.json.bak-anti-hall before writing.
# Prints a clear before/after diff and revert instructions.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPATCHER="${SCRIPT_DIR}/statusline.sh"
SETTINGS="${HOME}/.claude/settings.json"
BACKUP="${HOME}/.claude/settings.json.bak-anti-hall"

# Ensure the dispatcher is executable.
chmod +x "${DISPATCHER}"

# Sanity check: settings.json must exist.
if [ ! -f "${SETTINGS}" ]; then
  echo "ERROR: ${SETTINGS} not found. Is Claude Code installed?"
  exit 1
fi

# Back up settings.json before touching it.
cp "${SETTINGS}" "${BACKUP}"
echo "Backed up ${SETTINGS} -> ${BACKUP}"

# Read and modify with Python3 (safe JSON round-trip).
python3 - "${SETTINGS}" "${DISPATCHER}" <<'PYEOF'
import sys, json, os

settings_path = sys.argv[1]
dispatcher    = sys.argv[2]

with open(settings_path, 'r') as f:
    settings = json.load(f)

new_statusline = {
    "type": "command",
    "command": f"bash {dispatcher}",
    "padding": 0,
}

existing = settings.get("statusLine")
if existing:
    print(f"Existing statusLine: {json.dumps(existing)}")
else:
    print("No existing statusLine found.")

settings["statusLine"] = new_statusline
print(f"New statusLine:      {json.dumps(new_statusline)}")

with open(settings_path, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')

print(f"\nDone. {settings_path} updated.")
print(f"To revert: cp {settings_path}.bak-anti-hall {settings_path}")
PYEOF
