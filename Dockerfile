FROM node:24-slim

ENV NODE_ENV=production

WORKDIR /app

ARG IMAGE_REVISION=
ENV IMAGE_REVISION=$IMAGE_REVISION

COPY package.json policy.json policy-reconcile.json ./
COPY src ./src

RUN mkdir -p /app/out && chown node:node /app/out

USER node

# Runtime files are bind mounts, not baked into the image:
#   .env                 -> /app/.env
#   decisions directory  -> /app/out
CMD ["node", "src/lgl-vg/main.js"]
