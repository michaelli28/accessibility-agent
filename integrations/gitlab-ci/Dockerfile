# AT Agent GitLab CI Docker Image
# Based on Playwright image with Node.js 20

FROM mcr.microsoft.com/playwright:v1.40.0-jammy

# Set environment variables
ENV NODE_ENV=production
ENV HEADLESS=true
ENV DEBIAN_FRONTEND=noninteractive

# Install additional dependencies including Python for discovery agent
RUN apt-get update && apt-get install -y \
    curl \
    jq \
    bc \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Create symlink for python command
RUN ln -sf /usr/bin/python3 /usr/bin/python

# Set working directory
WORKDIR /at-agent

# Copy package files first for better caching
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci || npm install

# Copy the rest of the application
COPY . .

# Build the agent components
RUN npm run build || true

# Copy the entrypoint script
COPY gitlab-ci/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create output directory
RUN mkdir -p /output

# Set entrypoint
ENTRYPOINT ["/entrypoint.sh"]
