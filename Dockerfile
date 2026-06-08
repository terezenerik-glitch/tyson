FROM node:20-slim

# Codice in /opt/scanner (fuori dal volume mount /app di Bunny)
WORKDIR /app
COPY scanner.bundle.js .
COPY pack.json .

# Dipendenze runtime (non bundlate: @aws-sdk/client-s3)
COPY package.json .
RUN npm install --production

# Dati iniziali da git (copiati su volume /app al primo avvio)
COPY site/ /app/site/
COPY risultati/ /app/risultati/

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
