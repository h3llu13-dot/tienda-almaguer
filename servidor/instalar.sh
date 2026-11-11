#!/usr/bin/env bash
# =====================================================================
#  Tienda Almaguer: instalación en el VPS (Ubuntu o Debian), como root
#
#     bash instalar.sh [dominio]
#
#  - Convive con otros sitios del VPS (por ejemplo Kioscopos): detecta si
#    el servidor web es nginx, Caddy o Apache y AGREGA un sitio aparte, sin
#    tocar los existentes. Comprueba la configuración antes de recargar.
#  - Sin dominio (o si el dominio aún no apunta al VPS) usa
#    <ip-con-guiones>.sslip.io con HTTPS.
#  - Se puede volver a ejecutar para actualizar: datos y código se conservan.
# =====================================================================
set -euo pipefail

APP_DIR=/opt/tienda-almaguer
DATA_DIR=/var/lib/tienda-almaguer
ENV_FILE=/etc/tienda-almaguer.env
SITE=tienda-almaguer
SRC="$(cd "$(dirname "$0")" && pwd)"

say()  { printf '\n\033[1;31m▶\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
fail() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || fail "Ejecute como root."
command -v apt-get >/dev/null || fail "Este instalador es para Ubuntu o Debian."
[ -f "$SRC/server.js" ] && [ -f "$SRC/public/index.html" ] || fail "Falta server.js o public/ junto al instalador."
export DEBIAN_FRONTEND=noninteractive

# ---------- IP pública y dominio ----------
IP="$(curl -4 -fsS -m 10 https://api.ipify.org || curl -4 -fsS -m 10 https://ifconfig.me || hostname -I | awk '{print $1}')"
DOMAIN="${1:-}"
if [ -n "$DOMAIN" ]; then
  RES="$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}' || true)"
  if [ "$RES" != "$IP" ]; then
    warn "$DOMAIN no apunta a este VPS ($IP) todavía (resuelve a: ${RES:-nada})."
    warn "Se usará una dirección automática. Cuando cree el registro DNS, vuelva a ejecutar: bash instalar.sh $DOMAIN"
    DOMAIN=""
  fi
fi
[ -n "$DOMAIN" ] || DOMAIN="$(echo "$IP" | tr . -).sslip.io"
say "Dirección: https://$DOMAIN"

# ---------- Node.js ----------
say "Revisando Node.js…"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg >/dev/null
NODE_OK=0
if command -v node >/dev/null; then [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] && NODE_OK=1; fi
if [ "$NODE_OK" = 0 ]; then
  say "Instalando Node.js 20…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
NODE_BIN="$(command -v node)"

# ---------- Puerto libre (no choca con Kioscopos ni con nada más) ----------
PORT=""
if [ -f "$ENV_FILE" ]; then PORT="$(grep '^PORT=' "$ENV_FILE" | cut -d= -f2)"; fi
in_use() { ss -ltnH "sport = :$1" | grep -q .; }
if [ -z "$PORT" ] || { in_use "$PORT" && ! systemctl is-active --quiet tienda-almaguer; }; then
  for p in $(seq 8790 8899); do in_use "$p" || { PORT=$p; break; }; done
fi
[ -n "$PORT" ] || fail "No se encontró un puerto libre."

# ---------- Aplicación ----------
say "Instalando la aplicación (puerto interno $PORT)…"
id tienda >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin tienda
mkdir -p "$APP_DIR" "$DATA_DIR"
cp "$SRC/server.js" "$APP_DIR/"
rm -rf "$APP_DIR/public" && cp -r "$SRC/public" "$APP_DIR/public"
chown -R root:root "$APP_DIR"; chown -R tienda:tienda "$DATA_DIR"; chmod 700 "$DATA_DIR"

if [ ! -f "$ENV_FILE" ]; then
  KEY="${STORE_KEY:-$(tr -dc 'A-HJ-NP-Za-km-z2-9' </dev/urandom | head -c 12)}"
  printf 'STORE_KEY=%s\nPORT=%s\nHOST=127.0.0.1\nDATA_DIR=%s\n' "$KEY" "$PORT" "$DATA_DIR" > "$ENV_FILE"
else
  sed -i "s/^PORT=.*/PORT=$PORT/" "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"
KEY="$(grep '^STORE_KEY=' "$ENV_FILE" | cut -d= -f2-)"

cat > /etc/systemd/system/tienda-almaguer.service <<EOF
[Unit]
Description=Tienda Almaguer (inventario y punto de venta en línea)
After=network.target

[Service]
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $APP_DIR/server.js
User=tienda
Group=tienda
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable tienda-almaguer >/dev/null 2>&1
systemctl restart tienda-almaguer
sleep 2
curl -fsS "http://127.0.0.1:$PORT/api/ping" >/dev/null || fail "La aplicación no arrancó. Vea: journalctl -u tienda-almaguer -n 50"

# ---------- Servidor web: se agrega un sitio nuevo, sin tocar los existentes ----------
WEB="none"
LISTEN="$(ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null || true)"
if   echo "$LISTEN" | grep -q '"nginx"';   then WEB=nginx
elif echo "$LISTEN" | grep -q '"caddy"';   then WEB=caddy
elif echo "$LISTEN" | grep -qE '"(apache2|httpd)"'; then WEB=apache
elif [ -n "$LISTEN" ]; then WEB=other
fi
say "Servidor web detectado: $WEB"

certbot_ready() {
  command -v certbot >/dev/null || apt-get install -y -qq certbot >/dev/null
  apt-get install -y -qq "python3-certbot-$1" >/dev/null 2>&1 || true
}

case "$WEB" in
nginx)
  CONF=/etc/nginx/sites-available/$SITE.conf
  [ -d /etc/nginx/sites-available ] || CONF=/etc/nginx/conf.d/$SITE.conf
  BACKUP=""; [ -f "$CONF" ] && BACKUP="$(cat "$CONF")"
  if [ -f "$CONF" ] && grep -q "listen 443" "$CONF" && grep -q "server_name $DOMAIN;" "$CONF"; then
    # Ya tiene HTTPS de una instalación anterior: solo se actualiza el puerto
    sed -i "s#proxy_pass http://127.0.0.1:[0-9]*;#proxy_pass http://127.0.0.1:$PORT;#" "$CONF"
  else
    cat > "$CONF" <<EOF
# Tienda Almaguer (agregado por instalar.sh; no afecta a otros sitios)
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 60m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
EOF
  fi
  [ -d /etc/nginx/sites-enabled ] && ln -sf "$CONF" /etc/nginx/sites-enabled/$SITE.conf
  if ! nginx -t >/dev/null 2>&1; then
    # Se deshace el cambio para no afectar a los otros sitios
    if [ -n "$BACKUP" ]; then printf '%s\n' "$BACKUP" > "$CONF"; else rm -f "$CONF" /etc/nginx/sites-enabled/$SITE.conf; fi
    nginx -t; fail "La configuración de nginx no es válida; no se aplicó ningún cambio."
  fi
  systemctl reload nginx
  if ! grep -q "listen 443" "$CONF"; then
    say "Obteniendo certificado HTTPS…"
    certbot_ready nginx
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect \
      || warn "No se pudo obtener el certificado ahora. El sitio funciona por http://$DOMAIN; reintente: certbot --nginx -d $DOMAIN"
  fi
  ;;
caddy)
  CF=/etc/caddy/Caddyfile
  BLOCK="# --- Tienda Almaguer ---
$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT
	request_body {
		max_size 60MB
	}
}
# --- fin Tienda Almaguer ---"
  cp "$CF" "$CF.antes-tienda"
  awk '/# --- Tienda Almaguer ---/{skip=1} !skip{print} /# --- fin Tienda Almaguer ---/{skip=0}' "$CF" > "$CF.tmp" && mv "$CF.tmp" "$CF"
  printf '\n%s\n' "$BLOCK" >> "$CF"
  if ! caddy validate --config "$CF" --adapter caddyfile >/dev/null 2>&1; then
    mv "$CF.antes-tienda" "$CF"; fail "La configuración de Caddy no es válida; se restauró la anterior."
  fi
  systemctl reload caddy
  ;;
apache)
  a2enmod proxy proxy_http headers >/dev/null
  CONF=/etc/apache2/sites-available/$SITE.conf
  if ! { [ -f "$CONF" ] && grep -q "ServerName $DOMAIN" "$CONF" && [ -f /etc/apache2/sites-available/$SITE-le-ssl.conf ]; }; then
    cat > "$CONF" <<EOF
<VirtualHost *:80>
    ServerName $DOMAIN
    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:$PORT/
    ProxyPassReverse / http://127.0.0.1:$PORT/
    LimitRequestBody 62914560
</VirtualHost>
EOF
  else
    sed -i "s#http://127.0.0.1:[0-9]*/#http://127.0.0.1:$PORT/#g" "$CONF" /etc/apache2/sites-available/$SITE-le-ssl.conf
  fi
  a2ensite $SITE >/dev/null
  if ! apache2ctl configtest >/dev/null 2>&1; then a2dissite $SITE >/dev/null; fail "La configuración de Apache no es válida; no se aplicó."; fi
  systemctl reload apache2
  if [ ! -f /etc/apache2/sites-available/$SITE-le-ssl.conf ]; then
    certbot_ready apache
    certbot --apache -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect \
      || warn "No se pudo obtener el certificado ahora. Reintente: certbot --apache -d $DOMAIN"
  fi
  ;;
none)
  say "Instalando Caddy (HTTPS automático)…"
  if ! command -v caddy >/dev/null; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  printf '# --- Tienda Almaguer ---\n%s {\n\treverse_proxy 127.0.0.1:%s\n}\n# --- fin Tienda Almaguer ---\n' "$DOMAIN" "$PORT" > /etc/caddy/Caddyfile
  systemctl enable --now caddy >/dev/null 2>&1; systemctl reload caddy || systemctl restart caddy
  ;;
other)
  echo "$LISTEN"
  fail "Otro programa usa los puertos 80/443 (¿Docker/Traefik?). La aplicación ya funciona en 127.0.0.1:$PORT; no se tocó nada del servidor web. Envíe este mensaje a Claude para configurarlo."
  ;;
esac

if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi

# ---------- Comprobación final ----------
sleep 3
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 20 "https://$DOMAIN/api/ping" || true)"
[ "$CODE" = 200 ] && OK="✔ Comprobado por HTTPS" || OK="(HTTPS aún no responde: $CODE. Puede tardar un minuto.)"

cat <<EOF

=====================================================================
  ✔ Tienda Almaguer está en línea   $OK

    Dirección:           https://$DOMAIN
    Código de la tienda: $KEY

  · Abra la dirección e ingrese el código una vez en cada equipo.
  · Primer acceso de administrador: PIN 000000 (cámbielo enseguida).
  · Datos: $DATA_DIR  (copia diaria en $DATA_DIR/backups)
  · Estado: systemctl status tienda-almaguer
=====================================================================
EOF
