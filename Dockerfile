FROM denoland/deno:debian AS builder

WORKDIR /usr/src/app

COPY . .

RUN deno compile \
    --output server \
    --allow-net --allow-read --allow-write --allow-env \
    --include worker.ts \
    server.ts

FROM gcr.io/distroless/cc-debian13:debug
SHELL ["/busybox/busybox", "sh", "-c"]

WORKDIR /app

COPY --from=builder /tini /tini
COPY --from=builder /usr/src/app/server /app/server

RUN install -v -d -o nonroot -g nonroot -m 750 /app/player_cache /home/nonroot/.cache

EXPOSE 8001
USER nonroot
ENTRYPOINT ["/tini", "--"]
CMD ["/app/server"]
