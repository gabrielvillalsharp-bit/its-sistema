FROM node:20-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY backend/package.json ./backend/
RUN cd backend && npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "backend/server.js"]
