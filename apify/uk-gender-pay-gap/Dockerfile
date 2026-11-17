# gankdat actor image: package.json + src (self-contained; the client lives in src/gankdat.mjs).
FROM apify/actor-node:22
COPY package*.json ./
RUN npm --quiet set progress=false && npm install --omit=dev --omit=optional && echo "Installed:" && npm ls --omit=dev --omit=optional --all || true
COPY . ./
CMD npm start --silent
