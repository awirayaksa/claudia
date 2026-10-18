#!/usr/bin/env bash
# Claudia Web: offline install and upgrade on Ubuntu 24.04, from a bundle made
# by prepare-bundle.ps1.
#
#   tar -xf claudia-web-<version>-airgap-amd64.tar
#   cd claudia-web-<version>-airgap-amd64
#   sudo bash install.sh --public-url http://claudia.corp.internal:8080
#
# Installs Docker Engine from debs/ when it is missing, loads images/ and runs
# the app with PostgreSQL (pgvector) under docker compose in /opt/claudia.
# Nothing is fetched from the network.
#
# Run it the same way from a newer bundle to upgrade: .env (settings and
# secrets) is kept, and the database is dumped to /opt/claudia/backups first.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: sudo bash install.sh [options]

  --public-url URL        The URL users open, e.g. http://claudia.corp.internal:8080
                          (first install default: http://<this host's IP>:<port>)
  --port N                Host port of the app (default 8080)
  --sandbox-port N        Second host port for the code interpreter, artifact and
                          file previews (default 8081; 0 turns them off)
  --sandbox-origin URL    Instead of --sandbox-port: a separate host name that your
                          reverse proxy routes to this server
  --admin-email EMAIL     First admin account (first install only;
                          default admin@claudia.local)
  --admin-password PASS   Its password, 8+ characters (first install only;
                          default: generated and shown at the end)
  --postgres-password P   Password of an existing claudia_pgdata volume, when
                          installing again without the old .env
  --dir DIR               Install directory (default /opt/claudia)
  --skip-docker           Never install Docker from the bundle
  --no-backup             Upgrade without dumping the database first
  -h, --help              Show this help

Options given on an upgrade replace the values in <dir>/.env.
EOF
}

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

BUNDLE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
INSTALL_DIR=/opt/claudia
OPT_PUBLIC_URL=
OPT_PORT=
OPT_SANDBOX_PORT=
OPT_SANDBOX_ORIGIN=
OPT_ADMIN_EMAIL=
OPT_ADMIN_PASSWORD=
OPT_PG_PASSWORD=
SKIP_DOCKER=0
NO_BACKUP=0

need_value() { [[ $# -ge 2 && -n $2 ]] || die "$1 needs a value"; }

while [[ $# -gt 0 ]]; do
  case $1 in
    --public-url)        need_value "$@"; OPT_PUBLIC_URL=$2; shift 2 ;;
    --port)              need_value "$@"; OPT_PORT=$2; shift 2 ;;
    --sandbox-port)      need_value "$@"; OPT_SANDBOX_PORT=$2; shift 2 ;;
    --sandbox-origin)    need_value "$@"; OPT_SANDBOX_ORIGIN=$2; shift 2 ;;
    --admin-email)       need_value "$@"; OPT_ADMIN_EMAIL=$2; shift 2 ;;
    --admin-password)    need_value "$@"; OPT_ADMIN_PASSWORD=$2; shift 2 ;;
    --postgres-password) need_value "$@"; OPT_PG_PASSWORD=$2; shift 2 ;;
    --dir)               need_value "$@"; INSTALL_DIR=$2; shift 2 ;;
    --skip-docker)       SKIP_DOCKER=1; shift ;;
    --no-backup)         NO_BACKUP=1; shift ;;
    -h|--help)           usage; exit 0 ;;
    *)                   usage >&2; die "Unknown option: $1" ;;
  esac
done

is_port() { [[ $1 =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 )); }
is_url()  { [[ $1 =~ ^https?://[^/[:space:]]+/?$ ]]; }

[[ -z $OPT_PORT ]] || is_port "$OPT_PORT" || die "--port must be a port number"
[[ -z $OPT_SANDBOX_PORT || $OPT_SANDBOX_PORT == 0 ]] || is_port "$OPT_SANDBOX_PORT" || die "--sandbox-port must be a port number, or 0"
[[ -z $OPT_PUBLIC_URL ]] || is_url "$OPT_PUBLIC_URL" || die "--public-url must look like http(s)://host[:port], without a path"
[[ -z $OPT_SANDBOX_ORIGIN ]] || is_url "$OPT_SANDBOX_ORIGIN" || die "--sandbox-origin must look like http(s)://host[:port]"
[[ -z $OPT_ADMIN_PASSWORD || ${#OPT_ADMIN_PASSWORD} -ge 8 ]] || die "--admin-password needs at least 8 characters"
[[ -z $OPT_SANDBOX_PORT || -z $OPT_SANDBOX_ORIGIN ]] || die "Give --sandbox-port or --sandbox-origin, not both"

# Letters and digits only: safe unquoted in .env and in a postgres:// URL
random_string() {
  local s
  s=$(head -c 1024 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')
  printf '%s' "${s:0:$1}"
}

# The address other machines most likely reach this host on
host_address() {
  local ip
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }') || true
  [[ -n $ip ]] || ip=$(hostname -I 2>/dev/null | awk '{ print $1 }') || true
  [[ -n $ip ]] || ip=$(hostname -f 2>/dev/null || hostname)
  printf '%s' "$ip"
}

# --- Preflight ----------------------------------------------------------------

[[ $EUID -eq 0 ]] || die "Run as root: sudo bash $0 ..."
[[ -f $BUNDLE_DIR/bundle.env && -f $BUNDLE_DIR/SHA256SUMS ]] || die "bundle.env or SHA256SUMS is missing next to install.sh: run it from the extracted bundle."

# shellcheck source=/dev/null
. "$BUNDLE_DIR/bundle.env"
: "${CLAUDIA_VERSION:?}" "${CLAUDIA_IMAGE:?}" "${PGVECTOR_IMAGE:?}" "${BUNDLE_ARCH:?}"

# shellcheck source=/dev/null
os=$(. /etc/os-release && printf '%s %s' "${ID:-}" "${VERSION_ID:-}")
[[ $os == "ubuntu 24.04" ]] || warn "This bundle is made for Ubuntu 24.04; this host is '$os'. Carrying on."

host_arch=$(dpkg --print-architecture)
[[ $host_arch == "$BUNDLE_ARCH" ]] || die "This bundle is for $BUNDLE_ARCH but this host is $host_arch. Make one with: prepare-bundle.ps1 -Arch $host_arch"

log "Claudia Web $CLAUDIA_VERSION (${CLAUDIA_REVISION:0:12}), installing to $INSTALL_DIR"

log "Checking the bundle against SHA256SUMS"
(cd "$BUNDLE_DIR" && sha256sum --quiet --strict -c SHA256SUMS) \
  || die "The bundle is damaged or incomplete: copy it again."

# --- Docker -------------------------------------------------------------------

docker_ready() { command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; }

install_docker() {
  local debs=() todo=() deb pkg ver have
  shopt -s nullglob
  debs=("$BUNDLE_DIR"/debs/*.deb)
  shopt -u nullglob
  (( ${#debs[@]} )) || die "Docker (with the compose plugin) is not installed and this bundle has no debs/ (made with -SkipDockerPackages)."

  if dpkg-query -W -f='${Status}' docker.io 2>/dev/null | grep -q 'ok installed'; then
    die "Ubuntu's docker.io package is installed without 'docker compose'. Remove it (sudo apt-get remove docker.io) and run this again, or add the compose plugin yourself and use --skip-docker."
  fi

  # Skip what the host already has at the same or a newer version, so apt
  # never tries to downgrade (or reach a repository)
  for deb in "${debs[@]}"; do
    pkg=$(dpkg-deb -f "$deb" Package)
    ver=$(dpkg-deb -f "$deb" Version)
    have=$(dpkg-query -W -f='${Status} ${Version}\n' "$pkg" 2>/dev/null | head -n 1) || true
    if [[ $have == "install ok installed "* ]] && dpkg --compare-versions "${have##* }" ge "$ver"; then
      continue
    fi
    todo+=("$deb")
  done

  if (( ${#todo[@]} )); then
    log "Installing Docker Engine offline (${#todo[@]} packages)"
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${todo[@]}" \
      || die "Installing the Docker packages failed (see above). A missing dependency means this host lacks a package the bundle assumed; fetch that .deb too."
  fi
  systemctl enable --now containerd.service docker.service
}

if docker_ready; then
  log "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?') is installed"
elif (( SKIP_DOCKER )); then
  die "Docker with the compose plugin is not installed, and --skip-docker was given."
else
  install_docker
  docker_ready || die "Docker was installed but 'docker compose' does not work."
fi
systemctl is-active --quiet docker || systemctl start docker

# --- Images -------------------------------------------------------------------

log "Loading the images"
for tar in "$BUNDLE_DIR"/images/*.tar; do
  docker load -i "$tar"
done
docker image inspect "$CLAUDIA_IMAGE" "$PGVECTOR_IMAGE" >/dev/null \
  || die "$CLAUDIA_IMAGE or $PGVECTOR_IMAGE is missing after loading images/."

# --- Backup before an upgrade -------------------------------------------------

ENV_FILE=$INSTALL_DIR/.env
NEW_INSTALL=0
[[ -f $ENV_FILE ]] || NEW_INSTALL=1

if (( NEW_INSTALL )); then
  if docker volume inspect claudia_pgdata >/dev/null 2>&1 && [[ -z $OPT_PG_PASSWORD ]]; then
    die "A claudia_pgdata volume exists but $ENV_FILE does not. Pass --postgres-password with that database's password (web/docker's compose default is 'claudia'), or delete the old data: docker volume rm claudia_pgdata claudia_claudia-data"
  fi
else
  prev_image=$(grep -m 1 '^CLAUDIA_IMAGE=' "$ENV_FILE" | cut -d= -f2-) || true
  if (( NO_BACKUP )); then
    warn "Upgrading without a database backup (--no-backup)."
  elif [[ -n $(cd "$INSTALL_DIR" && docker compose ps -q --status running db 2>/dev/null) ]]; then
    install -d -m 0700 "$INSTALL_DIR/backups"
    dump=$INSTALL_DIR/backups/claudia-$(date +%Y%m%d-%H%M%S).dump
    log "Backing up the database to $dump"
    if ! (cd "$INSTALL_DIR" && docker compose exec -T db pg_dump -U claudia -d claudia -Fc) > "$dump"; then
      rm -f "$dump"
      die "The backup failed, so nothing was upgraded. Fix it, or run again with --no-backup."
    fi
    chmod 600 "$dump"
  else
    warn "The database is not running, so there is no backup before this upgrade."
  fi
fi

# --- Files and settings -------------------------------------------------------

install -d -m 0755 "$INSTALL_DIR" "$INSTALL_DIR/certs"
install -d -m 0700 "$INSTALL_DIR/backups"
install -m 0644 "$BUNDLE_DIR/compose.yml" "$BUNDLE_DIR/compose.sandbox.yml" "$BUNDLE_DIR/README.md" "$INSTALL_DIR/"
install -m 0644 "$BUNDLE_DIR/bundle.env" "$INSTALL_DIR/installed-bundle.env"

get_env() { grep -m 1 "^$1=" "$ENV_FILE" | cut -d= -f2- || true; }

# Sets KEY=VALUE in .env, replacing the line or adding it
set_env() {
  local tmp
  tmp=$(mktemp)
  if grep -q "^$1=" "$ENV_FILE"; then
    K=$1 V=$2 awk 'index($0, ENVIRON["K"] "=") == 1 { print ENVIRON["K"] "=" ENVIRON["V"]; next } { print }' "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp"
    printf '%s=%s\n' "$1" "$2" >> "$tmp"
  fi
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

GENERATED_PASSWORD=
if (( NEW_INSTALL )); then
  port=${OPT_PORT:-8080}
  admin_password=$OPT_ADMIN_PASSWORD
  if [[ -z $admin_password ]]; then
    admin_password=$(random_string 20)
    GENERATED_PASSWORD=$admin_password
  fi
  (umask 077 && cat > "$ENV_FILE" <<'EOF'
# Claudia Web settings, read by docker compose in this directory and passed to
# the app. Keep this file private and backed up: without CLAUDIA_SECRET_KEY
# the stored API keys and sign-in secrets can't be decrypted.
#
# Any variable from the Configuration table of the Claudia Web README (LDAP_*,
# ENABLE_PASSWORD_AUTH, OTEL_*, ...) can be added here. Apply changes with:
#   cd /opt/claudia && sudo docker compose up -d
# Quote values that contain $ or spaces with single quotes.

# First boot only: this admin is created while there are no users. Remove the
# password once you have signed in and changed it.
EOF
  )
  set_env CLAUDIA_ADMIN_EMAIL "${OPT_ADMIN_EMAIL:-admin@claudia.local}"
  set_env CLAUDIA_ADMIN_PASSWORD "$admin_password"
  printf '\n' >> "$ENV_FILE"
  set_env CLAUDIA_PORT "$port"
  set_env CLAUDIA_PUBLIC_URL "${OPT_PUBLIC_URL:-http://$(host_address):$port}"
  set_env CLAUDIA_SECRET_KEY "$(random_string 64)"
  set_env POSTGRES_PASSWORD "${OPT_PG_PASSWORD:-$(random_string 32)}"
  set_env LOG_LEVEL info
  sandbox_port=${OPT_SANDBOX_PORT:-8081}
  [[ -z $OPT_SANDBOX_ORIGIN ]] || sandbox_port=0
else
  [[ -z $OPT_PORT ]] || set_env CLAUDIA_PORT "$OPT_PORT"
  [[ -z $OPT_PUBLIC_URL ]] || set_env CLAUDIA_PUBLIC_URL "$OPT_PUBLIC_URL"
  if [[ -n $OPT_PORT && -z $OPT_PUBLIC_URL ]]; then
    warn "CLAUDIA_PUBLIC_URL is still $(get_env CLAUDIA_PUBLIC_URL); pass --public-url too if users should open the new port."
  fi
  [[ -z $OPT_PG_PASSWORD ]] || set_env POSTGRES_PASSWORD "$OPT_PG_PASSWORD"
  [[ -z $OPT_ADMIN_EMAIL && -z $OPT_ADMIN_PASSWORD ]] || warn "--admin-email/--admin-password only apply to a first install; ignored."
  if [[ -n $OPT_SANDBOX_ORIGIN ]]; then sandbox_port=0
  elif [[ -n $OPT_SANDBOX_PORT ]]; then sandbox_port=$OPT_SANDBOX_PORT
  else sandbox_port=$(get_env CLAUDIA_SANDBOX_PORT); sandbox_port=${sandbox_port:-0}
  fi
fi

set_env CLAUDIA_IMAGE "$CLAUDIA_IMAGE"
set_env PGVECTOR_IMAGE "$PGVECTOR_IMAGE"

# The sandbox (code interpreter, artifact and file previews) needs an origin
# of its own: a second port of this host, or a host name a reverse proxy
# routes here. compose.sandbox.yml publishes the port.
if [[ -n $OPT_SANDBOX_ORIGIN ]]; then
  set_env CLAUDIA_SANDBOX_ORIGIN "$OPT_SANDBOX_ORIGIN"
fi
if (( sandbox_port > 0 )); then
  set_env CLAUDIA_SANDBOX_PORT "$sandbox_port"
  set_env CLAUDIA_SANDBOX_ORIGIN ""
  set_env COMPOSE_FILE compose.yml:compose.sandbox.yml
else
  set_env CLAUDIA_SANDBOX_PORT ""
  set_env COMPOSE_FILE compose.yml
fi
chmod 600 "$ENV_FILE"

port=$(get_env CLAUDIA_PORT)
public_url=$(get_env CLAUDIA_PUBLIC_URL)

# --- Start --------------------------------------------------------------------

cd "$INSTALL_DIR"
log "Starting Claudia Web (database migrations run on start)"
if ! docker compose up -d --remove-orphans --wait --wait-timeout 300; then
  docker compose ps -a || true
  docker compose logs --tail 80 app || true
  die "Claudia Web did not become healthy. The logs above usually say why; settings are in $ENV_FILE."
fi

ready=$(docker compose exec -T app node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>r.text()).then(t=>console.log(t),()=>process.exit(1))" 2>/dev/null) || true
[[ -z $ready ]] || log "readyz: $ready"

# --- Summary ------------------------------------------------------------------

echo
printf '\033[1;32mClaudia Web %s is running.\033[0m\n\n' "$CLAUDIA_VERSION"
echo "  Open        $public_url"
if (( sandbox_port > 0 )); then
  echo "  Sandbox     port $sandbox_port (code interpreter, previews): open it to users too"
elif [[ -z $(get_env CLAUDIA_SANDBOX_ORIGIN) ]]; then
  echo "  Sandbox     off (no code interpreter or previews)"
fi
if (( NEW_INSTALL )); then
  echo "  Admin       $(get_env CLAUDIA_ADMIN_EMAIL)"
  if [[ -n $GENERATED_PASSWORD ]]; then
    echo "  Password    $GENERATED_PASSWORD   (generated; also in $ENV_FILE until you remove it)"
  fi
fi
echo "  Settings    $ENV_FILE"
echo "  Backups     $INSTALL_DIR/backups"
echo
echo "  Logs        cd $INSTALL_DIR && sudo docker compose logs -f app"
echo "  Restart     cd $INSTALL_DIR && sudo docker compose restart app"
if [[ -n ${prev_image:-} && $prev_image != "$CLAUDIA_IMAGE" ]]; then
  echo
  echo "  The previous image $prev_image is kept for a rollback (see README.md);"
  echo "  remove it later with: sudo docker image rm $prev_image"
fi
if [[ $public_url != *"$port"* ]]; then
  echo
  echo "  Users reach the app through $public_url: route it to port $port of this host."
fi
