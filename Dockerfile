FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# Copy only package.json first (better build caching)
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install

# Copy the rest of your project
COPY . .

EXPOSE 8080

CMD ["node", "index.js"]
