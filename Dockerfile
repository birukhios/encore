# Builds both web apps and the .NET API into one image. One port serves everything:
# guest app at /, organizer admin at /admin, API at /api and /admin/api. See render.yaml.
FROM node:20-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
# Production dependencies only: the embedded PostgreSQL used by `npm test` is not needed to build.
RUN npm ci --omit=dev --no-audit --no-fund
COPY admin.html guest.html vite.config.mjs ./
COPY public ./public
COPY src ./src
RUN node node_modules/vite/bin/vite.js build

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS api
WORKDIR /src
COPY backend/Encore.Api/Encore.Api.csproj Encore.Api/
RUN dotnet restore Encore.Api/Encore.Api.csproj
COPY backend/Encore.Api Encore.Api/
RUN dotnet publish Encore.Api/Encore.Api.csproj -c Release -o /out --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0
ENV ENCORE_ENV=production ENCORE_ROOT=/app ENCORE_DATA=/data HOST=0.0.0.0 PORT=8080 DOTNET_CLI_TELEMETRY_OPTOUT=1
WORKDIR /app
COPY --from=api /out ./api
COPY --from=web /app/dist ./dist
# All data and uploaded photos live in PostgreSQL. /data only holds a generated key when ENCORE_SECRET is unset.
RUN mkdir -p /data
EXPOSE 8080
CMD ["dotnet", "api/Encore.Api.dll"]
