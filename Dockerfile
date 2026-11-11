ARG MC_MONITOR_VERSION=0.15.5
FROM itzg/mc-monitor:${MC_MONITOR_VERSION} AS mcmonitor

FROM debian:stable-slim AS builder

ARG TARGETARCH
ARG MRPACK_INSTALL_VERSION=0.16.10
ARG PACK=the-modpack.mrpack

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl jq unzip && \
    rm -rf /var/lib/apt/lists/*

COPY scripts/install-pack.sh /usr/local/bin/
COPY ["${PACK}", "/tmp/pack"]
RUN bash /usr/local/bin/install-pack.sh

# glibc base: musl (alpine) Temurin 8 fails TLS handshakes with Mojang/Forge.
# :debug only adds busybox, needed by start-server.sh.
FROM gcr.io/distroless/cc-debian13:debug

ENV PATH=/opt/java/bin:/busybox:/usr/local/bin:/usr/bin:/bin

COPY --from=mcmonitor /mc-monitor /usr/local/bin/
COPY --from=builder /opt/java /opt/java
COPY --from=builder /opt/pack /opt/pack
COPY scripts/start-server.sh /usr/local/bin/

WORKDIR /data

EXPOSE 25564

ENTRYPOINT ["/busybox/sh", "/usr/local/bin/start-server.sh"]
