#!/usr/bin/env bash
set -euo pipefail
umask 077
hash=${1:?source hash required}
upload_env=${2:-no}
[[ $hash =~ ^[a-f0-9]{64}$ ]] || exit 2
root=/opt/matter-mailer
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another deployment is active'; exit 1; }
test "$(uname -m)" = x86_64
systemctl is-enabled docker
systemctl is-active docker
archive="$root/incoming/source-$hash.tar.gz"
echo "$hash  $archive" | sha256sum --check --status
# Never replace an active one-shot container or start a second process.
if test -n "$(docker ps -q --filter label=com.docker.compose.project=matter-mailer)"; then
  echo 'An assessment container is active; wait for its one-shot operation to finish before redeploying.'; exit 1
fi
if test "$upload_env" = yes; then
  chmod 600 "$root/incoming/env.new"
  new_start=$(sed -n 's/^MAIL_START_AT=//p' "$root/incoming/env.new")
  test -n "$new_start" || { echo 'MAIL_START_AT must be set once before credential transfer'; exit 1; }
  if test -f "$root/.env"; then
    old_start=$(sed -n 's/^MAIL_START_AT=//p' "$root/.env")
    test "$new_start" = "$old_start" || { echo 'MAIL_START_AT change rejected; preserve the original activation time'; exit 1; }
  fi
  mv "$root/incoming/env.new" "$root/.env"
fi
release="$root/releases/$hash"
mkdir -p "$release"
tar --extract --gzip --file "$archive" --directory "$release" --no-same-owner
cd "$release"
if ! docker build --tag "matter-mailer:$hash" . > "$root/build-$hash.log" 2>&1; then
  tail -n 60 "$root/build-$hash.log"
  exit 1
fi
image_id=$(docker image inspect --format '{{.Id}}' "matter-mailer:$hash")
printf 'MATTER_MAILER_IMAGE=matter-mailer:%s\nSOURCE_BUNDLE_SHA256=%s\nIMAGE_ID=%s\n' "$hash" "$hash" "$image_id" > "$release/.deploy.env"
if test -f "$root/.env"; then
  docker compose --env-file .deploy.env config --quiet
fi
ln -sfn "$release" "$root/current"
printf '{"sourceBundleSha256":"%s","imageId":"%s","deployedAt":"%s","daemonStarted":false}\n' "$hash" "$image_id" "$(date -u +%FT%TZ)" | tee "$root/deployment.json"
echo 'Build installed. No daemon started. Doctor/probe are explicit one-shot compose run --rm commands.'
