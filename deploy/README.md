# Production server

Everything the production machine needs is in this repository; secrets stay out of it (they live in
gitignored files on the laptop and in GitHub's repository secrets). Moving to a new machine is these steps.

| What | Where |
|---|---|
| Machine setup (packages, SSH, firewall, journald, updates, deploy key) | `scripts/provision.sh` → `deploy/provision-remote.sh` |
| Game and Caddy (compose, Caddyfile, Dockerfile, the deploy script) | `scripts/install-deploy.sh` → `/etc/crateball`, `/usr/local/bin/crateball-deploy` |
| Monitoring agent (Grafana Alloy) | `scripts/monitoring.sh` → `/opt/crateball-monitoring` |
| Grafana dashboard | `deploy/monitoring/dashboard.json` (import in Grafana) |
| Grafana alerts → Telegram | `node scripts/alerts.mjs` (rules in the script; secrets in `.alerts.env`, template `deploy/monitoring/alerts.env.example`) |
| Server caps, game processes | `/etc/crateball/.env` (optional; see `deploy/compose.yml`) |
| Maintenance mode | `sh scripts/maintenance.sh on\|off\|status` |

Local secret files (never committed): `.deploy.env` (host, SSH port, key path; template
`deploy/deploy.env.example`) and `.grafana.env` (template `deploy/monitoring/grafana.env.example`).

## Moving to a new machine

1. **Order a server**: Ubuntu 26.04 LTS, 4 dedicated vCPUs or more (the game runs 3 processes, Caddy and
   the coordinator share the 4th). Add your SSH key for root in the provider's panel.
2. **Point `.deploy.env` at it**: new host, keep `CRATEBALL_SSH_PORT` (the port SSH will move to).
3. **Set it up** (still over port 22; installs Docker, ufw, unattended upgrades, journald limits, moves
   SSH to the port, keys only, and adds the restricted deploy key):

   ```sh
   sh scripts/provision.sh start path/to/deploy_key.pub
   sh scripts/server.sh 'echo ok'      # works on the new port?
   sh scripts/provision.sh finish      # then close 22
   ```

   The deploy key is the public half of the key in the `DEPLOY_SSH_KEY` secret. Lost it? Make a new pair
   (`ssh-keygen -t ed25519 -f deploy_key -N ''`), pass `deploy_key.pub`, and put the private half in the
   secret (step 6).
4. **Install the deploy files and monitoring**:

   ```sh
   sh scripts/install-deploy.sh
   sh scripts/monitoring.sh
   ```

5. **DNS** (GoDaddy): A record `@` → the new address (TTL 600), `www` stays a CNAME to `@`. Caddy gets the
   certificate by itself once the name points at it.
6. **GitHub secrets** (Settings → Secrets → Actions): `DEPLOY_HOST` (`root@address`), `DEPLOY_PORT`,
   `DEPLOY_KNOWN_HOSTS` (`ssh-keyscan -p PORT address`), and `DEPLOY_SSH_KEY` if the key changed.
7. **First release**: GitHub → Actions → Release → Run workflow (or `gh workflow run release.yml --ref main`).
   Check `https://playcrateball.com/health` and `curl -sI https://playcrateball.com` (CSP, HSTS).
8. **Old machine**: keep it a day, then cancel it. Rooms live in memory, so nothing needs copying.

## Notes

- `provision-remote.sh` can run again on a configured machine (it rewrites the same files). It does not
  touch the game, Caddy or monitoring.
- Ubuntu starts sshd from `ssh.socket`; its generator takes the ports from the sshd config, which is why
  the script restarts `ssh.socket` after writing `/etc/ssh/sshd_config.d/00-crateball.conf`.
- Never commit the address, the SSH port or a key. The scripts read them from `.deploy.env`.
