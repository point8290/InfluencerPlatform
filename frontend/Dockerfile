# Development image running the Vite dev server. Not a production build —
# serving a static bundle is outside the scope of this assignment.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 5173

# --host 0.0.0.0 is supplied by docker-compose. Vite binds 127.0.0.1 by
# default, which inside a container is unreachable from the host.
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
