## Production Dockerfile - builds optimized React app and serves with Nginx

# Stage 1: Build the React app
FROM node:20-alpine AS build

WORKDIR /app

# Install dependencies separately for better caching
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy the rest of the application source
COPY public ./public
COPY src ./src

# Build the production bundle
RUN npm run build

# Stage 2: Serve the build output with Nginx
FROM nginx:1.27-alpine

# Copy built assets from previous stage
COPY --from=build /app/build /usr/share/nginx/html

# Expose HTTP on port 80 (Caddy will terminate HTTPS in front of this)
EXPOSE 80

# Run Nginx in the foreground to serve the static build
CMD ["nginx", "-g", "daemon off;"]


