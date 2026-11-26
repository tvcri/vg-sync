# The VG -> Mailchimp sync (compose service `mailchimp`). Holds only its own
# code: a change to another service's folder does not rebuild or redeploy it.
FROM node:24-slim

ENV NODE_ENV=production

WORKDIR /app

ARG IMAGE_REVISION=
ENV IMAGE_REVISION=$IMAGE_REVISION

COPY package.json ./
COPY src/vg-mailchimp ./src/vg-mailchimp

RUN mkdir -p /app/out && chown node:node /app/out

USER node

# Runtime files are bind mounts, not baked into the image:
#   .env                 -> /app/.env
#   records directory    -> /app/out
CMD ["node", "src/vg-mailchimp/main.js"]
