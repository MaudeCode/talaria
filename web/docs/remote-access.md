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
TALARIA_WEB_PASSWORD=your-secret talaria-web
```

3. Publish the local WebUI port through Tailscale Serve:

```bash
tailscale serve --bg 8787
```

4. Allow the MagicDNS hostname Tailscale prints, then restart WebUI:

```bash
TALARIA_WEB_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net TALARIA_WEB_PASSWORD=your-secret talaria-web
```

5. Open the HTTPS MagicDNS URL in your phone's browser.

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
auth; without a sign-in method the server refuses to start on a non-loopback
address:

```bash
TALARIA_WEB_HOST=0.0.0.0 TALARIA_WEB_PASSWORD=your-secret talaria-web
```

Then open `http://<server-tailscale-ip>:8787` in your phone's browser (find
your server's Tailscale IP in the Tailscale app or with `tailscale ip -4` on
the server).

That's it. Traffic is encrypted end-to-end by WireGuard, and password auth
protects the UI at the application level. You can add it to your home screen
for an app-like experience.

> **Tip:** If using Docker, set `TALARIA_WEB_HOST=0.0.0.0` in your
> `docker-compose.yml` environment (already the default), set
> `TALARIA_WEB_PASSWORD`, and remove `TALARIA_WEB_ALLOW_UNAUTHENTICATED=1`
> once the port is published beyond `127.0.0.1`.

## Behind a reverse proxy

### Allowed hostnames

WebUI answers only to `localhost`, IP addresses, the `TALARIA_WEB_HOST` name,
the hostnames in `TALARIA_WEB_ALLOWED_ORIGINS`, and the comma-separated names
in `TALARIA_WEB_ALLOWED_HOSTS`. A request whose `Host` header names anything
else gets `421 Misdirected Request` before authentication runs, and the first
rejection of each name logs a warning. This stops a web page from reaching the
server through DNS rebinding, where the attacker's own hostname resolves to
this machine. Matching ignores case and the port.

Behind a proxy, list the public hostname: `TALARIA_WEB_ALLOWED_HOSTS=webui.example.com`.
The `Host` header WebUI receives is always checked, so a proxy that rewrites it
to an internal name such as a Docker service needs that name listed too
(`TALARIA_WEB_ALLOWED_HOSTS=webui.example.com,talaria`). With
`TALARIA_WEB_TRUST_FORWARDED_HOST=1` and the proxy's address listed in
`TALARIA_WEB_TRUSTED_PROXY_CIDRS` (loopback is not trusted implicitly here, so
a same-host proxy lists `127.0.0.1/32`), the `X-Forwarded-Host` name must be
allowed as well.

### Client address

Set `TALARIA_WEB_TRUST_FORWARDED_FOR=1` to use the client address from
`X-Forwarded-For`. It applies only when the connection comes from a trusted
proxy. The request log and the local-origin onboarding gate trust loopback
implicitly. Login, passkey, native OIDC start, and TTS limits use a forwarded
client only from a proxy listed in `TALARIA_WEB_TRUSTED_PROXY_CIDRS`, so a
same-host proxy lists `127.0.0.1/32` (and `::1/128`). A proxy on another host
or a Docker bridge must be listed too (for example `172.17.0.1` or
`10.0.0.0/8`). When the opt-in is set and no proxy outside this host is listed,
startup prints a reminder.

The proxy must append the address it received the request from to
`X-Forwarded-For` (nginx: `proxy_set_header X-Forwarded-For
$proxy_add_x_forwarded_for;`). A proxy that passes the client's own header
through unchanged lets the client choose the logged address.

### Client IP in the request log

Each request-log record carries at most one of these fields:

- `forwarded_for`: the client address, present only with the opt-in, a trusted
  proxy peer, and an `X-Forwarded-For` chain that resolves to a valid address
  other than the peer. It is always a normalized address (IPv4-mapped IPv6 is
  written as IPv4), never header text. Key fail2ban jails on this field.
- `forwarded_for_ignored: true`: a nonblank `X-Forwarded-For` arrived but was
  not recorded, because the opt-in is off, the peer is not a trusted proxy, or
  the chain is malformed, ends in a scoped IPv6 address, or names only trusted
  proxies. The first ignored header from an untrusted peer also logs a one-time
  warning naming that peer.

The request log never reads `X-Real-IP`, because proxies relay a
client-supplied value unchanged. The local-origin onboarding gate still falls
back to `X-Real-IP` from a trusted proxy when there is no `X-Forwarded-For`,
and the limits above count a request against the proxy's own budget when its
`X-Real-IP` names a different client. Configure the proxy to overwrite it
(`proxy_set_header X-Real-IP $remote_addr;`).

### Trusted-header sign-in

With `TALARIA_WEB_TRUSTED_AUTH_HEADER` set, an authenticating proxy names the
signed-in user in that header, and `TALARIA_WEB_TRUSTED_GROUPS_HEADER` can carry
the groups that `TALARIA_WEB_GROUP_PROFILE_MAP` binds to profiles. The header
counts only on a connection from a proxy listed in
`TALARIA_WEB_TRUSTED_PROXY_CIDRS`; loopback is not trusted implicitly, because
another local process or a relay such as `ssh -L`, `cloudflared`, or
`tailscale serve` could otherwise name any user. A same-host proxy lists
`127.0.0.1/32` (and `::1/128`); a proxy on another host or a Docker bridge lists
its own address. Until a proxy is listed, trusted-header sign-in rejects every
request, and startup logs a warning naming the variable.

The proxy must overwrite both headers on every request, never append to or pass
through a client's value; only the last groups header field is read. In nginx,
`proxy_set_header` replaces the client's header:

```nginx
auth_request_set $auth_user $upstream_http_remote_user;
auth_request_set $auth_groups $upstream_http_remote_groups;
proxy_set_header X-Remote-User $auth_user;
proxy_set_header X-Remote-Groups $auth_groups;
```

In Caddy, `forward_auth ... { copy_headers Remote-User Remote-Groups }` and
`header_up X-Remote-User {http.auth.user.id}` replace the header; never use
`header_up +X-Remote-User`, which appends. When you do not map groups, remove the
groups header (`header_up -X-Remote-Groups`).

---
