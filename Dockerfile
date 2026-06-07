FROM node:18-slim

WORKDIR /app

# Single bundled file + config (no node_modules needed)
COPY scanner.bundle.js .
COPY pack.json .

# Cartelle runtime (gia' presenti in git)
COPY risultati/ ./risultati/
COPY site/ ./site/

CMD ["node", "scanner.bundle.js"]
