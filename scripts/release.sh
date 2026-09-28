#!/bin/bash
# Release NovaConnect through the standard pipeline on NOVAAPP01, from a developer machine.
#
#   scripts/release.sh <version> "<reason>" "<release-notes line>" "<change>" ["<change>" ...]
#
# Releases the commit at local HEAD, which must already be pushed to origin/main, with
# src/version.js and package.json both at <version>. On the server it:
#   1. fast-forwards ~/novaconnect to that commit and checks it matches;
#   2. builds releases/NovaConnect-v<version>/ — overlay tarball (git archive of the commit),
#      release-manifest.json, RELEASE-NOTES.md, SHA256SUMS.txt;
#   3. runs upgrade-novaconnect.sh --check, then --yes (tags :stable, restarts via systemd,
#      health check, automatic rollback on failure);
#   4. prints the post-deploy checklist (server HEAD = origin, version in the container,
#      :stable = :<version> = running image, MEDIASOUP_ANNOUNCED_IP set, recent log errors,
#      login page status) and updates STABLE-RELEASE.json.
# Only for overlay releases (src/ views/ public/). A change to dependencies or Containerfile.base
# needs the base image rebuilt first. A schema change must be applied (additively, so the running
# version keeps working) before releasing, then released with NOVACONNECT_DB_MIGRATION set to the
# migration's name — recorded as "databaseChanges": true in the manifest, notes and STABLE-RELEASE.
#
# Settings (environment): NOVACONNECT_SSH_KEY (default ~/.ssh/nuvrion_lab), NOVACONNECT_SSH_USER
# (default hiteshhasija), NOVACONNECT_HOSTS (default "10.0.0.102 10.0.0.101" — the first that
# answers a ping; .101 is the same VM, for when this machine's route to .102 drops out).
set -euo pipefail

if [ $# -lt 4 ]; then
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi
V=$1; REASON=$2; NOTES=$3; shift 3

REPO=$(cd "$(dirname "$0")/.." && pwd)
KEY=${NOVACONNECT_SSH_KEY:-$HOME/.ssh/nuvrion_lab}
USER_AT=${NOVACONNECT_SSH_USER:-hiteshhasija}
HOSTS=${NOVACONNECT_HOSTS:-"10.0.0.102 10.0.0.101"}
MIGRATION=${NOVACONNECT_DB_MIGRATION:-}

# --- local checks: what we release is exactly what's pushed, and the version files agree ---
cd "$REPO"
git fetch -q origin
C=$(git rev-parse --short HEAD)
[ -z "$(git status --porcelain -- src views public package.json)" ] || { echo "Uncommitted changes in src/ views/ public/ package.json — commit (and push) first." >&2; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "Local HEAD ($C) is not origin/main — push first (or check out the commit you mean to release)." >&2; exit 1; }
grep -q "module.exports = '$V';" src/version.js || { echo "src/version.js is not at $V." >&2; exit 1; }
[ "$(node -p "require('./package.json').version")" = "$V" ] || { echo "package.json is not at $V." >&2; exit 1; }

H=""
for candidate in $HOSTS; do
  if ping -c1 -t 3 "$candidate" >/dev/null 2>&1; then H=$candidate; break; fi
done
[ -n "$H" ] || { echo "None of $HOSTS answered." >&2; exit 1; }
echo "Releasing NovaConnect $V ($C) via $H"

CHANGES=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@")
MANIFEST=$(python3 - "$V" "$C" "$REASON" "$CHANGES" "$MIGRATION" <<'EOF'
import json, sys
v, c, reason, changes, migration = sys.argv[1:6]
m = {"version": v, "artifact": f"NovaConnect-Overlay-{v}.tar.gz", "gitCommit": c,
  "product": "NovaConnect", "databaseChanges": bool(migration), "source": "hiteshhasija-lab/NovaConnect",
  "reason": reason, "changes": json.loads(changes)}
if migration: m["databaseMigration"] = migration + " (additive; applied before this release)"
print(json.dumps(m, indent=2))
EOF
)
if [ -n "$MIGRATION" ]; then DBNOTE="Database migration $MIGRATION (additive, applied beforehand)."; else DBNOTE="No database changes."; fi
NOTESFILE=$(printf '# NovaConnect %s\n\n- %s %s\n' "$V" "$NOTES" "$DBNOTE")

# The remote script's arguments go through the remote shell, so quote them for it.
ssh -i "$KEY" -o ConnectTimeout=8 "$USER_AT@$H" bash -s -- $(printf '%q ' "$V" "$C" "$REASON" "$DBNOTE") <<REMOTE
set -euo pipefail
V=\$1; C=\$2; REASON=\$3; DBNOTE=\$4
D=~/novaconnect-upgrades/releases/NovaConnect-v\$V
[ ! -e "\$D" ] || { echo "\$D already exists — pick the next version." >&2; exit 1; }
echo "latest release before: \$(ls ~/novaconnect-upgrades/releases | sort -V | tail -1)"
cd ~/novaconnect && git pull -q --ff-only && test "\$(git rev-parse --short HEAD)" = "\$C"
mkdir -p \$D
git archive --format=tar.gz -o \$D/NovaConnect-Overlay-\$V.tar.gz \$C Containerfile.overlay public src views
cat > \$D/release-manifest.json <<'JSON'
$MANIFEST
JSON
cat > \$D/RELEASE-NOTES.md <<'NOTES'
$NOTESFILE
NOTES
cd \$D && sha256sum NovaConnect-Overlay-\$V.tar.gz release-manifest.json > SHA256SUMS.txt && python3 -m json.tool release-manifest.json >/dev/null
~/novaconnect-upgrades/upgrade-novaconnect.sh \$D --check 2>&1 | tail -1
~/novaconnect-upgrades/upgrade-novaconnect.sh \$D --yes 2>&1 | tail -3
echo "--- post-deploy checklist"
echo "server HEAD \$(cd ~/novaconnect && git rev-parse --short HEAD) / origin \$(cd ~/novaconnect && git rev-parse --short origin/main)"
echo "version in container: \$(podman exec novaconnect-api sh -c "tail -1 src/version.js")"
echo "MEDIASOUP_ANNOUNCED_IP set: \$(podman exec novaconnect-api sh -c 'env | grep -c MEDIASOUP_ANNOUNCED_IP')"
echo ":stable / :\$V / running: \$(podman image inspect --format '{{.Id}}' localhost/novaconnect:stable | cut -c1-12) \$(podman image inspect --format '{{.Id}}' localhost/novaconnect:\$V | cut -c1-12) \$(podman inspect --format '{{.Image}}' novaconnect-api | cut -c1-12)"
echo "log errors (2 min, excluding machine-id noise): \$(podman logs --since 2m novaconnect-api 2>&1 | grep -i 'error\|exception' | grep -vc machine-id || true)"
RB=\$(ls -t ~/novaconnect-upgrades/backups | head -1)
cd ~/novaconnect-upgrades && cp STABLE-RELEASE.json STABLE-RELEASE.json.bak-before-\$V
python3 - "\$V" "\$C" "\$RB" "\$REASON" "\$DBNOTE" <<'PY'
import json, sys, datetime
v, c, rb, reason, dbnote = sys.argv[1:6]
p = "STABLE-RELEASE.json"; d = json.load(open(p))
d.update(stableVersion=v, markedStableAt=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  markedBy="scripts/release.sh (user-authorized deployment)", image=f"localhost/novaconnect:{v}",
  releaseDirectory=f"/home/hiteshhasija/novaconnect-upgrades/releases/NovaConnect-v{v}",
  rollbackImage="localhost/novaconnect:rollback-" + rb, reason=reason + f" gitCommit {c}. " + dbnote)
json.dump(d, open(p, "w"), indent=2); print("STABLE-RELEASE.json ->", d["stableVersion"])
PY
echo "login page: \$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 https://10.0.0.102/login)"
REMOTE
echo "local HEAD $C"
