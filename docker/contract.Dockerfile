# Build image for the Rust contract. Rust 1.81 avoids wasm features nearcore rejects.
FROM rust:1.81-slim
RUN rustup target add wasm32-unknown-unknown && useradd -m -u 1000 builder
USER builder
WORKDIR /work
