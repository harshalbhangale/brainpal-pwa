# syntax=docker/dockerfile:1.7
# One image for the API, the worker and one-off migration tasks; the ECS task
# definition chooses which with its command. The web app is built by Vercel.

FROM node:24-bookworm-slim AS build
WORKDIR /repo
ENV CI=true
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter brainpal --filter "@brainpal/api..." --filter "@brainpal/worker..."
RUN pnpm turbo run build --filter=@brainpal/api --filter=@brainpal/worker
RUN pnpm install --prod --frozen-lockfile --filter "@brainpal/api..." --filter "@brainpal/worker..."

FROM node:24-bookworm-slim
WORKDIR /repo
ENV NODE_ENV=production
# RDS requires TLS; the pool verifies against this bundle via DATABASE_SSL_CA.
# Not under /etc/ssl: the slim image has no such directory, and letting ADD
# create it leaves it unreadable, which stops Node loading its OpenSSL config.
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /opt/rds/global-bundle.pem
RUN chmod 755 /opt/rds
COPY --from=build --chown=node:node /repo /repo
USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]
