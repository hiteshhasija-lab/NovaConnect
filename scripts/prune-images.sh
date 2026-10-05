#!/bin/bash
# Free disk space on NOVAAPP01 by removing OLD NovaConnect images and build folders. Every release
# builds a new image (a few hundred MB once older ones pin old base layers) and leaves a build
# folder behind; on 2026-10-04 that filled the 17 GB disk and a base build failed (#40).
# scripts/release.sh runs this after every healthy release; it can also be run by hand.
#
# Always kept: :stable, :base, every :base-pre-* rollback base, the image the running container
# uses, the KEEP_VERSIONS newest version tags (e.g. :1.0.179) and the KEEP_ROLLBACKS newest
# :rollback-* tags — so the upgrade script's automatic rollback and a manual one to any recent
# version still work. Removed images are rebuildable from the release folders, which stay.
# NovaDesk and Nuvrion images are not touched.
#
#   bash scripts/prune-images.sh          preview
#   bash scripts/prune-images.sh --yes    remove
set -euo pipefail
KEEP_VERSIONS=${KEEP_VERSIONS:-5}
KEEP_ROLLBACKS=${KEEP_ROLLBACKS:-5}
KEEP_BUILDS=${KEEP_BUILDS:-3}
REPO=localhost/novaconnect
BUILDS=~/novaconnect-upgrades/builds

running=$(podman inspect -f '{{.Image}}' novaconnect-api 2>/dev/null || true)
tags=$(podman images --format '{{.Tag}}' --filter "reference=$REPO" | grep -v '<none>' | sort -u)
versions=$(echo "$tags" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V || true)
rollbacks=$(echo "$tags" | grep -E '^rollback-' | sort || true)
keep=$( { echo stable; echo base; echo "$tags" | grep -E '^base-pre-' || true;
          echo "$versions" | tail -n "$KEEP_VERSIONS"; echo "$rollbacks" | tail -n "$KEEP_ROLLBACKS"; } | sort -u)

remove=()
while read -r t; do
  [ -z "$t" ] && continue
  grep -qxF "$t" <<<"$keep" && continue
  id=$(podman image inspect -f '{{.Id}}' "$REPO:$t")
  [ -n "$running" ] && [ "$id" = "$running" ] && continue
  remove+=("$t")
done <<<"$tags"
old_builds=()
if [ -d "$BUILDS" ]; then
  while read -r b; do [ -n "$b" ] && old_builds+=("$b"); done < <(ls -1dt "$BUILDS"/v* 2>/dev/null | tail -n +$((KEEP_BUILDS + 1)))
fi

free() { df -h / | awk 'NR==2{print $4" free ("$5" used)"}'; }
echo "cleanup: ${#remove[@]} old NovaConnect image tag(s), ${#old_builds[@]} old build folder(s); disk $(free)"
if [ "${1:-}" != "--yes" ]; then
  [ ${#remove[@]} -gt 0 ] && echo "  would remove: ${remove[*]}"
  echo "  preview only; run with --yes to remove"; exit 0
fi
for t in "${remove[@]}"; do podman rmi "$REPO:$t" >/dev/null 2>&1 || echo "  kept $t (still in use)"; done
for b in "${old_builds[@]}"; do rm -rf -- "$b"; done
podman image prune -f >/dev/null
echo "cleanup done; disk $(free)"
