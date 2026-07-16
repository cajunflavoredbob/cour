# Running cour behind a reverse proxy

Many people choose to run services behind a reverse proxy. This page aims to provide some documentation to spare lots of duplicated effort (and bug tickets).

## WebSocket Origin check (read this first)

cour rejects a WebSocket upgrade whose `Origin` header doesn't match the
request `Host` -- a guard against cross-site WebSocket hijacking. Behind a
reverse proxy this means **the proxy must forward the original `Host`
header** (`proxy_set_header Host $host;` in nginx). If it forwards its own
`Host` instead, the browser's `Origin` won't match and the upgrade fails
with `403 Forbidden`.

If your proxy can't forward `Host`, or serves cour under an origin that
differs from the `Host` cour receives, set the `ALLOWED_ORIGINS` env var to
the external origin(s) instead (comma-separated), e.g.
`ALLOWED_ORIGINS=https://cour.example.com`.

The examples below all include `proxy_set_header Host $host;`.

## Rate limiting behind a proxy (know the tradeoff)

cour deliberately keys its per-IP protections (request rate limits, the
Basic Auth failure throttle, WebSocket connection caps) on the **real TCP
peer address** and never trusts `X-Forwarded-For` -- a client-supplied
header is trivially spoofable, and trusting it would let an attacker
dodge every throttle. The flip side: behind a reverse proxy, the "real
peer" for every client is the proxy itself, so **all clients share one
budget**. On a WAN-exposed deployment with Basic Auth, ten bad passwords
a minute from one attacker will throttle logins for everyone behind that
proxy until the attacker stops.

What to do about it:

- Rate-limit and fail2ban **at the proxy**, where the real client IP is
  known. The proxy is the right place for per-client limits in this
  topology; cour's own limits then act as a whole-service backstop.
- Keep cour LAN-only (or behind a VPN) and skip the exposure entirely --
  the deployment cour is designed for.

Also, when the proxy runs on the same host as the container, don't leave
cour published on all interfaces: change the compose port mapping from
`8000:8000` to `127.0.0.1:8000:8000` so the only way in is through the
proxy.

## Nginx

### Behind a subdomain

```nginx.conf
events {
  worker_connections 4096;
}

http {
  server {
    listen 9000;
    server_name cour.example.com;

    location ^~ / {
        proxy_pass http://localhost:8000/;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
  }
}
```

### Behind a subpath

Run cour normally, and use the following `nginx.conf`.

```nginx.conf
events {
  worker_connections 4096;
}

http {
  server {
    listen 9000;

    location ^~ /cour/ {
        proxy_pass http://localhost:8000/;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-Prefix /cour;
    }

    location ^~ / {
        proxy_pass http://localhost:8000/;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
  }
}
```

## HAProxy

### Behind a subdomain

```haproxy.cfg
frontend https
  mode http
  bind 0.0.0.0:443 name bind_1 crt /etc/haproxy/certs ssl alpn h2,http/1.1
  http-request set-header X-Forwarded-Proto https if { ssl_fc }
  use_backend cour-http if { req.hdr(host),field(1,:) -i cour.example.com } { path_beg / }

backend cour-http
  mode http
  balance roundrobin
  option forwardfor
  server cour localhost:8000
```

## Apache2

Make sure to enable the Apache2 mods first (`a2enmod` takes module names
without the `mod_` prefix, and plain-HTTP proxying needs `proxy_http`):

```
a2enmod proxy proxy_http proxy_wstunnel rewrite
```

```xml
<VirtualHost *:80>
  ServerName cour.example.com
  ServerAlias cour.example.com
  ProxyPass / http://localhost:8000/
  RewriteEngine on
  RewriteCond %{HTTP:Upgrade} websocket [NC]
  RewriteCond %{HTTP:Connection} upgrade [NC]
  RewriteRule ^/?(.*) "ws://localhost:8000/$1" [P,L]
</VirtualHost>
```
