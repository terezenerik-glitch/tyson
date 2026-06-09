#!/bin/sh
set -e

echo "[ENTRYPOINT] Starting..."

# Bunny CDN monta volume fresco su /app — prima copia i dati dall'immagine
mkdir -p /app/site /app/risultati/DATA_SPLIT /app/logs /app/whoisds

[ -d /opt/site ] && cp -r /opt/site/* /app/site/
[ -d /opt/risultati ] && cp -r /opt/risultati/* /app/risultati/

echo "[ENTRYPOINT] Avvio scanner..."
exec node /opt/scanner/scanner.bundle.js
