# Use official Playwright base image with Chromium & all dependencies preinstalled
FROM mcr.microsoft.com/playwright:v1.47.1-jammy

# Set working directory
WORKDIR /app

# Copy package files first (for layer caching)
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install

# Copy the rest of your app
COPY . .

# Expose port Railway expects
EXPOSE 8080

# Start your API
CMD ["npm", "start"]
