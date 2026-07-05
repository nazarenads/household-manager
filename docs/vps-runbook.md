# VPS Runbook — Phase 1.5 through the first watched purchase

Copy-pasteable steps for provisioning the worker VPS, validating the S2.0
spike, and running the first watched Tienda Kay purchase. Assumes root SSH;
if you use a non-root user, shift `/root/...` paths accordingly and keep
`WORKER_SECRETS_FILE` pointing at wherever you actually write the file.

## 1. Rent the VPS

- Provider: any Argentina/Buenos Aires host (Vultr, AWS `ar-buenos-aires`, …)
- Specs: 2 GB RAM minimum, 20 GB disk, Ubuntu 22.04 LTS
- Firewall: expose **only port 22** publicly. CDP (9222) and noVNC (6080)
  are reached over Tailscale — never open them to the internet. CDP binds to
  `127.0.0.1` anyway (see §7).

## 2. Base packages

```bash
ssh root@<vps-ip>
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt update
apt install -y nodejs git build-essential
npm install -g pnpm
node --version   # 20.x
```

## 3. Display stack (headful Chrome needs a display)

`WORKER_HEADLESS=false`, so Chrome needs an X display: Xvfb provides a
virtual one, x11vnc exposes it, noVNC/websockify serves it to a browser.

```bash
apt install -y xvfb x11vnc novnc websockify
# If novnc/websockify aren't packaged on your image:
#   git clone https://github.com/novnc/noVNC.git ~/novnc
#   git clone https://github.com/novnc/websockify.git ~/novnc/utils/websockify
```

## 4. Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up          # authenticate via the printed URL
tailscale ip -4       # note this IP — it's how you reach noVNC
```

## 5. Clone, install, and fetch Playwright's Chromium

Stagehand runs `env: "LOCAL"`, which launches **Playwright's bundled
Chromium** — apt's `chromium-browser` is not what gets used.

```bash
cd ~ && git clone <your-repo-url> household-manager
cd household-manager
pnpm install
npx -y playwright install --with-deps chromium
```

## 6. Worker environment

The worker reads `process.env` only — nothing auto-loads a .env file.
Write plain `KEY=value` lines (systemd `EnvironmentFile` format; also
sourceable with `set -a`):

```bash
mkdir -p ~/.household-manager
cat > ~/.household-manager/worker.env <<'EOF'
DISPLAY=:0
CONVEX_URL=https://<your-deployment>.convex.cloud
WORKER_TOKEN=<same secret as the Convex env var; MINIMUM 16 characters>
WORKER_ID=vps-1
ANTHROPIC_API_KEY=<required for spike observe/heal and first-contact runs>
STAGEHAND_MODEL=anthropic/claude-haiku-4-5
WORKER_PROFILE_ROOT=/root/.household-manager/profiles
WORKER_SECRETS_FILE=/root/household-secrets.json
WORKER_CDP_PORT=9222
WORKER_HEADLESS=false
HARNESS_ALLOW_API_BILLING=false
HARNESS_CLI=claude
EOF
chmod 600 ~/.household-manager/worker.env
```

`ANTHROPIC_API_KEY` is a deliberate opt-in (D11), but it is **required**
here: spike `observe`/`heal` and any stagehand run that isn't a fully
cached replay make LLM calls. Only `HARNESS_ALLOW_API_BILLING` is safe to
leave off — that flag only controls whether the `claude -p` child bills the
API instead of your subscription.

Load it in any interactive shell before running worker commands:

```bash
set -a; source ~/.household-manager/worker.env; set +a
```

## 7. systemd units (display stack + worker survive reboots)

The S2.0 gate includes surviving a reboot; manually backgrounded processes
die with the SSH session. Install these four units:

```bash
cat > /etc/systemd/system/xvfb.service <<'EOF'
[Unit]
Description=Virtual X display :0

[Service]
ExecStart=/usr/bin/Xvfb :0 -screen 0 1280x800x24
Restart=always

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/x11vnc.service <<'EOF'
[Unit]
Description=VNC server on display :0 (localhost only; Tailscale is the path in)
After=xvfb.service
Requires=xvfb.service

[Service]
ExecStart=/usr/bin/x11vnc -display :0 -forever -shared -nopw -localhost -rfbport 5900
Restart=always

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/novnc.service <<'EOF'
[Unit]
Description=noVNC web client on :6080
After=x11vnc.service
Requires=x11vnc.service

[Service]
ExecStart=/usr/bin/websockify --web=/usr/share/novnc 6080 localhost:5900
Restart=always

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/household-worker.service <<'EOF'
[Unit]
Description=Household manager purchase worker
After=network-online.target xvfb.service
Wants=network-online.target
Requires=xvfb.service

[Service]
WorkingDirectory=/root/household-manager
EnvironmentFile=/root/.household-manager/worker.env
ExecStart=/usr/bin/pnpm --filter @household/worker dev
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now xvfb x11vnc novnc
# Enable the worker only after the spike + login drill pass:
#   systemctl enable --now household-worker
```

noVNC is now at `http://<vps-tailscale-ip>:6080/vnc.html` (Tailscale
devices only — x11vnc listens on localhost, websockify proxies it).

## 8. S2.0 spike — validate the trajectory cache

Run on the VPS after sourcing the env (§6). The `<store>` argument accepts
the store's `login_ref` (e.g. `tienda-kay`), name, or Convex id — the CLI
resolves it to the store `_id`, which is the key the persistent profile
lives under. **This matters:** real purchase jobs open the profile keyed by
the store id, so the spike/login must use the same one (the resolver
guarantees it).

```bash
# 1. Launch: profile + CDP persistence
pnpm --filter @household/worker spike launch tienda-kay https://<store-domain>/
```

- Prints `Store:`, `Profile:`, and `CDP endpoint:` lines.
- Verify CDP **on the VPS**: `curl http://127.0.0.1:9222/json/version`.
  Chrome binds remote debugging to localhost, so curling the Tailscale IP
  from your laptop fails even when everything is healthy. From your laptop,
  tunnel first if you want to check: `ssh -L 9222:127.0.0.1:9222 root@<ip>`.
- Ctrl+C, `reboot`, re-run, and confirm the profile directory (and any
  logged-in session) survived.

```bash
# 2. Observe: resolve an instruction to an action and persist it (LLM)
pnpm --filter @household/worker spike observe tienda-kay https://<store-domain>/ \
  "Type coffee into the search box and open the first result" action.json

# 3. Replay: must print "Replay succeeded with 0 LLM tokens (zero-LLM confirmed)"
pnpm --filter @household/worker spike replay tienda-kay https://<store-domain>/ action.json

# 4. Heal: sabotage the selector in action.json (keep the JSON shape), then
pnpm --filter @household/worker spike heal tienda-kay https://<store-domain>/ \
  action.json "Type coffee into the search box and open the first result"
```

Heal first re-tries the cached action and only heals when it fails — edit
the existing `action.json`'s selector to something bogus rather than
writing a new object from scratch.

## 9. Secrets file

The store key is the store's `login_ref`; the card object needs `holder`,
`number`, `expiry`, `cvv` (schema: `apps/worker/src/secrets.ts`).
`paymentRef` is just a label linking the store to a `payments` entry.

```bash
cat > /root/household-secrets.json <<'EOF'
{
  "stores": {
    "tienda-kay": {
      "username": "your-email@example.com",
      "password": "your-password",
      "paymentRef": "visa-prepaid"
    }
  },
  "proxies": {},
  "payments": {
    "visa-prepaid": {
      "holder": "NOMBRE APELLIDO",
      "number": "4111111111111111",
      "expiry": "12/25",
      "cvv": "123"
    }
  }
}
EOF
chmod 600 /root/household-secrets.json
```

## 10. One-time login drill

With noVNC open in a browser tab (§7), authenticate the persistent profile:

```bash
set -a; source ~/.household-manager/worker.env; set +a
pnpm --filter @household/worker run login tienda-kay https://<store-domain>/account
```

Log in over noVNC, then Ctrl+C. The session persists in the profile.

## 11. First watched purchase

1. `systemctl enable --now household-worker` (or run `pnpm --filter
@household/worker dev` in a shell with the env sourced).
2. In the dashboard: approve a 2–3 item Tienda Kay cart and queue it.
3. Worker log shows `[worker] claimed job <id> (stagehand)` — Tienda Kay is
   pinned to stagehand via its store `executor_override`. (Stores without an
   override and without recorded trajectories route to the harness explorer;
   that's Mercado Libre's path later.)
4. Watch over noVNC. A captcha pauses the job as `paused_captcha` — solve
   it in noVNC, then Resume from the dashboard.
5. Review the summary (screenshot + diff) and Confirm from the dashboard or
   the Telegram bot.
6. Verify the order in the store's account, and that the job ends `done`.

## 12. Telegram bot on the VPS (optional)

The bot process authenticates with `BOT_CONVEX_TOKEN` (its default
`local-dev` is rejected once Clerk/WORKER_TOKEN is configured). The Convex
side falls back to `WORKER_TOKEN` if no separate `BOT_CONVEX_TOKEN` Convex
env var is set, but the bot process still needs the value:

```bash
BOT_CONVEX_TOKEN=<same secret as WORKER_TOKEN> \
CONVEX_URL=... TELEGRAM_BOT_TOKEN=... TELEGRAM_ALLOWED_USER_IDS=... \
pnpm --filter @household/bot dev
```
