# syntax=docker/dockerfile:1.7

ARG OPENSUSE_IMAGE=opensuse/tumbleweed

FROM ${OPENSUSE_IMAGE} AS base

ARG NODEJS_MAJOR=22
ARG NODEJS_REPO=auto
ARG PI_WEB_EXTRA_ZYPPER_PACKAGES=""
ARG PI_WEB_UID=1000
ARG PI_WEB_GID=1000

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
  SHELL=/bin/bash \
  TERM=xterm-256color

COPY docker/internal/image/install-opensuse-base /usr/local/sbin/install-pi-web-opensuse-base
RUN chmod 0755 /usr/local/sbin/install-pi-web-opensuse-base \
  && install-pi-web-opensuse-base

FROM base AS build

WORKDIR /build

COPY package.json package-lock.json ./
COPY scripts/install-git-hooks.mjs scripts/install-git-hooks.mjs
RUN npm ci --min-release-age=0

COPY . .
RUN npm run build

FROM base AS runtime

ENV HOME=/data/home \
  XDG_CONFIG_HOME=/data/config \
  PI_WEB_CONFIG=/data/config/pi-web/config.json \
  PI_WEB_DATA_DIR=/data/pi-web \
  PI_WEB_SESSIOND_SOCKET=/data/pi-web/sessiond.sock \
  PI_CODING_AGENT_DIR=/data/pi-agent \
  PI_WEB_HOST=0.0.0.0 \
  PI_WEB_SPAWN_SESSIONS=true \
  PI_WEB_SUBSESSIONS=true \
  PI_WEB_REQUIRE_HTTP_AUTH=true \
  PI_WEB_DOCKER_RUNTIME=1 \
  PI_WEB_DOCKER_MODE=runtime \
  PATH=/opt/pi-web/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
  SHELL=/bin/bash \
  TERM=xterm-256color

WORKDIR /opt/pi-web

COPY --from=build /build/package.json ./package.json
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY --chmod=0755 docker/railway-entrypoint /usr/local/bin/pi-web-railway-entrypoint
COPY --chmod=0755 docker/railway-supervisor /usr/local/bin/pi-web-railway-supervisor

RUN ln -sf /opt/pi-web/node_modules/.bin/pi /usr/local/bin/pi

EXPOSE 8080

# Railway volumes are initially owned by root. The entrypoint initializes the
# mount and then drops both long-lived processes to the unprivileged pi-web user.
USER root
ENTRYPOINT ["/usr/sbin/tini-static", "--", "/usr/local/bin/pi-web-railway-entrypoint"]
