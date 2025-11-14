FROM mcr.microsoft.com/playwright:v1.47.1-jammy

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies (Playwright already included in the base image)
RUN npm install

# Copy the rest of the project
COPY . .

EXPOSE 8080
CMD ["node", "index.js"]
