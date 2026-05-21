FROM node:20-alpine

WORKDIR /app

RUN mkdir -p public

COPY dev/server.js ./server.js
COPY index.html manifest.json sw.js ./public/

EXPOSE 8080

CMD ["node", "server.js"]
