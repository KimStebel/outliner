# Build against musl so the result runs on a bare alpine with no toolchain.
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM alpine:3
# Unprivileged, and with no home or shell: this process only reads and writes
# one file.
RUN adduser -D -H -u 10001 app
# Created here, owned by the user that runs: a named volume inherits the
# ownership of the image's directory, and without this it arrives owned by
# root and every write fails with EACCES. A bind mount still has to be chowned
# on the host, which is what the deploy script does.
RUN mkdir -p /data && chown 10001:10001 /data
COPY --from=build /src/target/release/outliner-sync /usr/local/bin/outliner-sync
USER 10001:10001
ENV DATA_DIR=/data \
    BIND=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/outliner-sync"]
