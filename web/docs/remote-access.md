# Remote access

How to reach a self-hosted Hermes WebUI from another machine or your phone.

## Accessing from a remote machine

The server binds to `127.0.0.1` by default (loopback only). If you are running
Hermes on a VPS or remote server, use an SSH tunnel from your local machine:

```bash
ssh -N -L <local-port>:127.0.0.1:<remote-port> <user>@<server-host>
```

Example:

```bash
ssh -N -L 8787:127.0.0.1:8787 user@your.server.com
```

Then open `http://localhost:8787` in your local browser.

`talaria-web` will print this command for you automatically when it detects you
are running over SSH.

---

## Accessing on your phone with Tailscale

[Tailscale](https://tailscale.com) is a zero-config mesh VPN built on
WireGuard. Install it on your server and your phone, and they join the same
private network -- no port forwarding, no SSH tunnels, no public exposure.

The Hermes Web UI is fully responsive with a mobile-optimized layout
(hamburger sidebar, sidebar top tabs in the drawer, touch-friendly controls),
so it works well as a daily-driver agent interface from your phone.

**Preferred setup: Tailscale Serve**

1. Install [Tailscale](https://tailscale.com/download) on your server and
   your iPhone/Android.
2. Keep the WebUI bound to localhost and enable password auth:

```bash
HERMES_WEBUI_PASSWORD=your-secret talaria-web
```

3. Publish the local WebUI port through Tailscale Serve:

```bash
tailscale serve --bg 8787
```

4. Open the HTTPS MagicDNS URL that Tailscale prints in your phone's browser.

Tailscale Serve keeps WebUI on loopback while giving your tailnet an HTTPS
MagicDNS hostname. On Linux, changing Serve configuration may require elevated
permissions. If `tailscale serve --bg 8787` reports `Access denied: serve
config denied`, either run it with sudo:

```bash
sudo -S -p '' tailscale serve --bg 8787
```

Or allow the supervised non-root WebUI/Hermes user to manage Tailscale:

```bash
sudo -S -p '' tailscale set --operator=$USER
tailscale serve --bg 8787
```

**Fallback: direct tailnet IP**

Use direct tailnet access when Tailscale Serve is unavailable, disabled, or not
permitted. Because this binds WebUI beyond loopback, always enable password
auth:

```bash
HERMES_WEBUI_HOST=0.0.0.0 HERMES_WEBUI_PASSWORD=your-secret talaria-web
```

Then open `http://<server-tailscale-ip>:8787` in your phone's browser (find
your server's Tailscale IP in the Tailscale app or with `tailscale ip -4` on
the server).

That's it. Traffic is encrypted end-to-end by WireGuard, and password auth
protects the UI at the application level. You can add it to your home screen
for an app-like experience.

> **Tip:** If using Docker, set `HERMES_WEBUI_HOST=0.0.0.0` in your
> `docker-compose.yml` environment (already the default) and set
> `HERMES_WEBUI_PASSWORD`.

---
