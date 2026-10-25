# Build: compiles the agent for every OS (served at /dl/) and runs the relay server.
FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY shared shared
COPY agent agent
COPY relay relay
COPY scripts scripts
RUN bun run scripts/build-agent.ts

FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY package.json ./
COPY --from=build /app/node_modules node_modules
COPY shared shared
COPY relay relay
COPY --from=build /app/dist dist
ENV PORT=7777 DIST_DIR=/app/dist TONTON_DATA_DIR=/data
VOLUME /data
EXPOSE 7777
CMD ["bun", "relay/src/main.ts"]
