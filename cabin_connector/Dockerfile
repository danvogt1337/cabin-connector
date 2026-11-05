ARG BUILD_FROM
FROM ${BUILD_FROM}
# Node.js 22 (eingebauter WebSocket-Client, TypeScript ohne Übersetzen); openssl nur für das eigene Zertifikat des
# Tablet-Zugangs (einmal erzeugt); keine weiteren Pakete
RUN apk add --no-cache nodejs openssl
WORKDIR /app
COPY app/ /app/
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "/app/start.ts"]
