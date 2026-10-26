FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production COOKIE_SECURE=1 TRUST_PROXY=1
EXPOSE 3000
CMD ["npm", "start"]
