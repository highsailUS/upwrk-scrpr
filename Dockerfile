FROM mcr.microsoft.com/playwright:v1.47.1-jammy

WORKDIR /app

# Copy ONLY package.json
COPY package.json ./

# Install dependencies
RUN npm install

# Copy the rest of the project
COPY . .

EXPOSE 8080
CMD ["node", "index.js"]
