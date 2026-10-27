# The relay as a single executable. Built for the host or, with buildx, cross-compiled for amd64 and arm64.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4 AS build
ARG TARGETARCH
ARG VERSION=0.0.0
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY shared shared
COPY relay relay
# The website it serves.
COPY web web
RUN arch=$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64) && \
    bun build --compile --minify --target=bun-linux-$arch --define=process.env.TONTON_VERSION=\"$VERSION\" \
      relay/src/main.ts --outfile /tonton-relay && \
    mkdir /data

FROM debian:bookworm-slim
COPY --from=build /tonton-relay /usr/local/bin/tonton-relay
# No RUN here: the image builds for other architectures without emulation.
COPY --from=build --chown=65534:65534 /data /data
ENV PORT=7777 TONTON_DATA_DIR=/data
USER 65534
VOLUME /data
EXPOSE 7777
CMD ["tonton-relay"]
