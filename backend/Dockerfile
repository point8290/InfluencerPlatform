# Development image. There is no production build target here — a deployable
# image is outside the scope of this assignment, and the brief asks not to
# gold-plate.
FROM node:22-alpine

WORKDIR /app

# Manifests first, so the dependency layer stays cached until dependencies
# actually change rather than on every source edit.
COPY package.json package-lock.json ./
RUN npm ci

# In development docker-compose bind-mounts ./backend over /app, so this COPY
# only takes effect when the image is built and run on its own.
COPY . .

EXPOSE 4000

CMD ["npm", "run", "dev"]
