#!/bin/sh
# Runs ON a fresh Ubuntu (26.04 LTS) server as root: everything about the machine that is not the game
# itself. Safe to run again (each step only writes what is missing or different). Started from the
# laptop by scripts/provision.sh, which passes:
#   $1  the SSH port to move to (from .deploy.env)
#   $2  "finish" to close port 22 once the new port is known to work, else "start"
# and the restricted deploy key (public half) on stdin, or nothing.
set -eu
SSH_PORT=$1
PHASE=${2:-start}
DEPLOY_PUB=$(cat || true)

say() { printf '\n== %s\n' "$*"; }

if [ "$PHASE" = "finish" ]; then
  if [ "$SSH_PORT" = "22" ]; then
    echo "SSH portu 22: kapatılacak bir şey yok"
    exit 0
  fi
  say "port 22 kapanıyor (SSH artık yalnızca $SSH_PORT)"
  ufw delete allow 22/tcp >/dev/null 2>&1 || true
  ufw status
  exit 0
fi

say "paketler: docker, compose, ufw, otomatik güvenlik güncellemeleri"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q docker.io docker-compose-v2 ufw unattended-upgrades
systemctl enable --now docker

say "saat dilimi"
timedatectl set-timezone Europe/Istanbul

say "otomatik güvenlik güncellemeleri"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

say "journald: kalıcı, en fazla 500 MB (oyun logları yayınlardan sonra da kalır)"
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/crateball.conf <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=500M
EOF
systemctl restart systemd-journald

say "güvenlik duvarı: SSH ($SSH_PORT ve geçiş bitene kadar 22), 80, 443 (tcp + udp/http3)"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp comment ssh >/dev/null
ufw allow "$SSH_PORT/tcp" comment ssh >/dev/null
ufw allow 80/tcp comment http >/dev/null
ufw allow 443/tcp comment https >/dev/null
ufw allow 443/udp comment http3 >/dev/null
ufw --force enable >/dev/null
ufw status

say "SSH: yalnızca anahtar, root şifreyle giremez, port $SSH_PORT (22 de açık kalır: 'finish' kapatır)"
cat > /etc/ssh/sshd_config.d/00-crateball.conf <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
Port 22
EOF
[ "$SSH_PORT" = "22" ] || echo "Port $SSH_PORT" >> /etc/ssh/sshd_config.d/00-crateball.conf
sshd -t
# Ubuntu starts sshd from ssh.socket; its generator reads the ports from sshd_config.
systemctl daemon-reload
systemctl restart ssh.socket 2>/dev/null || true
systemctl restart ssh

if [ -n "$DEPLOY_PUB" ]; then
  say "deploy anahtarı: yalnızca crateball-deploy çalıştırabilir"
  case "$DEPLOY_PUB" in
    ssh-ed25519\ *) ;;
    *) echo "deploy anahtarı 'ssh-ed25519 ...' biçiminde olmalı" >&2; exit 1 ;;
  esac
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
  key=$(printf '%s' "$DEPLOY_PUB" | awk '{print $2}')
  if ! grep -q "$key" /root/.ssh/authorized_keys; then
    printf 'restrict,command="/usr/local/bin/crateball-deploy" %s\n' "$DEPLOY_PUB" >> /root/.ssh/authorized_keys
  fi
fi

say "tamam. Sıradaki: README'deki adımlar (install-deploy, monitoring, GitHub secret'ları, DNS)"
