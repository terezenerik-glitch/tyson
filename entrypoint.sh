#!/bin/sh
set -e

echo "[ENTRYPOINT] Starting..."

# Assicura che le directory dati esistano su /app
mkdir -p /app/risultati/DATA_SPLIT /app/site /app/logs

# Copia file iniziali da immagine a volume al primo avvio
if [ -d /opt/site ] && [ -z "$(ls -A /app/site 2>/dev/null)" ]; then
  echo "[ENTRYPOINT] Primo avvio: copio site/ nel volume..."
  cp -r /opt/site/* /app/site/ 2>/dev/null || true
fi
if [ -d /opt/risultati ] && [ -z "$(ls -A /app/risultati 2>/dev/null)" ]; then
  echo "[ENTRYPOINT] Primo avvio: copio risultati/ nel volume..."
  cp -r /opt/risultati/* /app/risultati/ 2>/dev/null || true
fi

echo "[ENTRYPOINT] Avvio scanner..."
exec node /opt/scanner/scanner.bundle.js
