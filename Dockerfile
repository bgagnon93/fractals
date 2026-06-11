# Build stage
FROM node:22-alpine as build

WORKDIR /app

# Install Rust and wasm-pack with build tools required for Rust compilation
RUN apk add --no-cache curl build-base && \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && \
    . $HOME/.cargo/env && \
    rustup target add wasm32-unknown-unknown && \
    curl -fsSL https://rustwasm.github.io/wasm-pack/installer/init.sh | sh

ENV PATH="/root/.cargo/bin:${PATH}"

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build WASM module (required before building the app)
RUN npm run build:wasm

# Build the app
RUN npm run build

# Production stage
FROM nginx:alpine

# Copy built assets to nginx
COPY --from=build /app/dist /usr/share/nginx/html

# Expose port
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
