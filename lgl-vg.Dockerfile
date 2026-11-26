# The LGL <-> VG sync (compose service `sync`). Holds only its own code:
# a change to another service's folder does not rebuild or redeploy it.
FROM node:24-slim

ENV NODE_ENV=production

WORKDIR /app

ARG IMAGE_REVISION=
ENV IMAGE_REVISION=$IMAGE_REVISION

COPY package.json policy.json policy-reconcile.json ./
COPY src/lgl-vg ./src/lgl-vg

RUN mkdir -p /app/out && chown node:node /app/out

USER node

# Runtime files are bind mounts, not baked into the image:
#   .env                 -> /app/.env
#   decisions directory  -> /app/out
CMD ["node", "src/lgl-vg/main.js"]
