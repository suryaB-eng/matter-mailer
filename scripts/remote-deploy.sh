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
oneoff_ids() {
  docker ps --filter label=com.docker.compose.project=matter-mailer --format '{{.ID}} {{.Label "com.docker.compose.oneoff"}}' | awk 'tolower($2)=="true" { print $1 }'
}
service_ids() {
  docker ps --filter label=com.docker.compose.project=matter-mailer --format '{{.ID}} {{.Label "com.docker.compose.oneoff"}}' | awk 'tolower($2)!="true" { print $1 }'
}
archive="$root/incoming/source-$hash.tar.gz"
echo "$hash  $archive" | sha256sum --check --status
# Leave the running poller up while the image builds. A one-shot command holds the same runtime lock.
if test -n "$(oneoff_ids)"; then
  echo 'A one-shot container is active; wait for it to finish before redeploying.'; exit 1
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
test -f "$root/.env" || { echo 'Host credentials are missing; poller not started.'; exit 1; }
docker compose --env-file .deploy.env config --quiet
if test -n "$(oneoff_ids)"; then
  echo 'A one-shot container is active; wait for it to finish before redeploying.'; exit 1
fi
if test -f "$root/current/compose.yaml" && test -f "$root/current/.deploy.env"; then
  docker compose --project-directory "$root/current" --env-file "$root/current/.deploy.env" stop --timeout 40 app || true
fi
if test -n "$(docker ps -q --filter label=com.docker.compose.project=matter-mailer)"; then
  echo 'A container is still active; not starting a second poller.'; exit 1
fi
ln -sfn "$release" "$root/current"
docker compose --project-directory "$release" --env-file "$release/.deploy.env" up -d --no-deps --force-recreate app
sleep 5
id=$(service_ids)
count=$(printf '%s\n' "$id" | grep -c . || true)
if test "$count" -ne 1; then echo "Expected one poller, found $count"; exit 1; fi
status=$(docker inspect --format '{{.State.Status}}' "$id")
restart=$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$id")
if test "$status" != running || test "$restart" != unless-stopped; then
  docker logs --tail 40 "$id" || true
  echo "Poller did not stay up (status=$status restart=$restart)"; exit 1
fi
printf '{"sourceBundleSha256":"%s","imageId":"%s","deployedAt":"%s","daemonStarted":true}\n' "$hash" "$image_id" "$(date -u +%FT%TZ)" | tee "$root/deployment.json"
echo 'One poller is running.'
