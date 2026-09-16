# Builds both web apps, then runs the Python server.
# Local/VPS: two ports (8081 admin, 8082 guest) behind an HTTPS proxy (see deploy/Caddyfile).
# Render and other one-port hosts: set ENCORE_SINGLE_PORT=1 (guest at /, admin at /admin) — see render.yaml.
FROM node:20-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY admin.html guest.html vite.config.mjs ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 ENCORE_ENV=production ENCORE_DATA=/data HOST=0.0.0.0 PORT=8081 GUEST_PORT=8082
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py domain.py db.py sms.py launch.py ./
COPY --from=web /app/dist ./dist
# Runs as root so an optional host-mounted disk at /data is writable. With DATABASE_URL, data lives in PostgreSQL.
RUN mkdir -p /data
EXPOSE 8081 8082
CMD ["python", "launch.py", "--no-browser"]
