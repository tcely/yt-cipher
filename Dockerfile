ARG XDG_CACHE_HOME

FROM denoland/deno:debian AS builder

WORKDIR /usr/src/app

##RUN apt-get update && apt-get install -y git jq

COPY . .

##RUN test '!' -e ejs || rm -v -rf ejs ; git clone https://github.com/yt-dlp/ejs.git ejs
### Pin to a specific commit
##RUN cd ejs && \
##    git checkout 2655b1f55f98e5870d4e124704a21f4d793b4e1c && \
##    cd .. && \
##    jq_filter='.dependencies|to_entries|map("npm:" + .key + "@" + .value)|.[]' && \
##    jq -r "${jq_filter}" ejs/package.json | xargs -r -t deno add
##
RUN deno compile \
    --output server \
    --allow-net --allow-read --allow-write --allow-env \
    --include worker.ts \
    server.ts

FROM ghcr.io/tcely/docker-tini:main@sha256:d57e136fc426e768461935e497702f8ca8b18d6751564f8a81877538e0554080 AS tini-bin
FROM scratch AS tini
ARG TARGETARCH TINI_VERSION="0.19.0"
COPY --from=tini-bin "/releases/v${TINI_VERSION}/tini-static-${TARGETARCH}" /tini

FROM gcr.io/distroless/cc-debian13:debug
SHELL ["/busybox/busybox", "sh", "-c"]

WORKDIR /app

COPY --from=tini /tini /tini
COPY --from=builder /usr/src/app/server /app/server

COPY --from=builder --chown=nonroot:nonroot /usr/src/app/docs /app/docs

ARG XDG_CACHE_HOME
ENV XDG_CACHE_HOME="${XDG_CACHE_HOME}"
# Create the fall-back cache directories
RUN install -v -d -o nonroot -g nonroot -m 750 \
        /app/player_cache /home/nonroot/.cache && \
    test -z "${XDG_CACHE_HOME}" || install -v -d -m 1777 "${XDG_CACHE_HOME}"

EXPOSE 8001
USER nonroot
ENTRYPOINT ["/tini", "--"]
# Run the server as nonroot even when /tini runs as root
# CMD ["/busybox/busybox", "su", "-s", "/app/server", "nonroot"]
CMD ["/app/server"]
