FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

# PORT = direkter Zugriff (config.yaml "ports"), INGRESS_PORT = HA-Sidebar
# (config.yaml "ingress_port"). server.js startet auf beiden.
ENV PORT=3000
ENV INGRESS_PORT=8099

EXPOSE 3000
EXPOSE 8099

CMD [ "node", "server.js" ]
