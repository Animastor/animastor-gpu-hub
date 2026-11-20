#!/usr/bin/env bash
# Refuse to release onto an image tag that already exists in the registry.
#
# Usage: ghcr-tag-absent.sh <registry> <image> <tag>
#   env GHCR_USER, GHCR_TOKEN — credentials with read access to the package.
#
# Exit codes (fail closed — anything but a clean 404 stops the release):
#   0  tag is absent (manifest HEAD → 404): safe to build and push
#   1  tag already exists (manifest HEAD → 200): pick a new tag
#   2  cannot tell (no credentials, token or registry error, other HTTP code)
#
# Release tags are immutable: re-pushing an existing tag would silently move
# it to a different digest under anyone who pinned the tag instead of the digest.
set -uo pipefail

if [ $# -ne 3 ]; then
  echo "usage: $0 <registry> <image> <tag>" >&2
  exit 2
fi
REG=$1 IMG=$2 TAG=$3

if [ -z "${GHCR_USER:-}" ] || [ -z "${GHCR_TOKEN:-}" ]; then
  echo "ghcr-tag-absent: GHCR_USER / GHCR_TOKEN are not set — cannot check '$IMG:$TAG'" >&2
  exit 2
fi

# Credentials go through a curl config on stdin, never on the command line.
TOKEN_JSON=$(printf 'user = "%s:%s"\n' "$GHCR_USER" "$GHCR_TOKEN" |
  curl -fsS --connect-timeout 10 --max-time 30 -K - "https://$REG/token?service=$REG&scope=repository:$IMG:pull") || {
  echo "ghcr-tag-absent: token request to $REG failed — cannot check '$IMG:$TAG'" >&2
  exit 2
}
BEARER=$(printf '%s' "$TOKEN_JSON" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
if [ -z "$BEARER" ]; then
  echo "ghcr-tag-absent: no token in the $REG response — cannot check '$IMG:$TAG'" >&2
  exit 2
fi

ACCEPT='application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'
CODE=$(printf 'header = "Authorization: Bearer %s"\n' "$BEARER" |
  curl -sS --connect-timeout 10 --max-time 30 -K - -o /dev/null -w '%{http_code}' -I -H "Accept: $ACCEPT" \
    "https://$REG/v2/$IMG/manifests/$TAG") || CODE=000

case "$CODE" in
  404)
    echo "ghcr-tag-absent: $REG/$IMG:$TAG is free"
    exit 0 ;;
  200)
    echo "ghcr-tag-absent: $REG/$IMG:$TAG ALREADY EXISTS — release tags are immutable, choose a new image_tag" >&2
    exit 1 ;;
  *)
    echo "ghcr-tag-absent: manifest check for $REG/$IMG:$TAG returned HTTP $CODE — cannot tell, refusing" >&2
    exit 2 ;;
esac
