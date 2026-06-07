FROM node:18-slim

# Codice in /opt/scanner (fuori dal volume mount /app di Bunny)
WORKDIR /opt/scanner
COPY scanner.bundle.js .
COPY pack.json .

# Dati iniziali da git (copiati su volume /app al primo avvio)
COPY site/ /opt/site/
COPY risultati/ /opt/risultati/

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
