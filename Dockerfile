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
RUN managed_package_source="$(jq -r '.packages[0].installSource' deploy/pi-profile/packages.json)" \
  && managed_package_version="$(jq -r '.packages[0].version' deploy/pi-profile/packages.json)" \
  && PI_CODING_AGENT_DIR=/build/managed-agent \
    ./node_modules/.bin/pi install "$managed_package_source" \
  && installed_package_version="$(node -p 'require("/build/managed-agent/npm/node_modules/pi-subagents/package.json").version')" \
  && test "$installed_package_version" = "$managed_package_version"

FROM base AS runtime

ARG PNPM_VERSION=11.22.0

RUN corepack enable \
  && corepack install --global "pnpm@${PNPM_VERSION}" \
  && test "$(pnpm --version)" = "$PNPM_VERSION"

ENV HOME=/data/home \
  GH_CONFIG_DIR=/data/config/gh \
  XDG_CONFIG_HOME=/data/config \
  PI_WEB_CONFIG=/data/config/pi-web/config.json \
  PI_WEB_DATA_DIR=/data/pi-web \
  PI_WEB_SESSIOND_SOCKET=/data/pi-web/sessiond.sock \
  PI_CODING_AGENT_DIR=/data/pi-agent \
  PI_WEB_HOST=0.0.0.0 \
  PI_WEB_SPAWN_SESSIONS=true \
  PI_WEB_SUBSESSIONS=false \
  PI_WEB_REQUIRE_HTTP_AUTH=true \
  PI_WEB_DOCKER_RUNTIME=1 \
  PI_WEB_DOCKER_MODE=runtime \
  PATH=/data/pi-agent/bin:/data/home/.cargo/bin:/opt/pi-web/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
  SHELL=/bin/bash \
  TERM=xterm-256color

WORKDIR /opt/pi-web

COPY --from=build /build/package.json ./package.json
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY deploy/pi-profile /opt/pi-web-managed-profile
COPY --from=build /build/managed-agent/npm /opt/pi-web-managed-profile/npm
COPY scripts/merge-managed-pi-profile.mjs /opt/pi-web/scripts/merge-managed-pi-profile.mjs
COPY --chmod=0755 docker/railway-entrypoint /usr/local/bin/pi-web-railway-entrypoint
COPY --chmod=0755 docker/railway-supervisor /usr/local/bin/pi-web-railway-supervisor

RUN ln -sf /opt/pi-web/node_modules/.bin/pi /usr/local/bin/pi

EXPOSE 8080

# Railway volumes are initially owned by root. The entrypoint initializes the
# mount and then drops both long-lived processes to the unprivileged pi-web user.
USER root
ENTRYPOINT ["/usr/sbin/tini-static", "--", "/usr/local/bin/pi-web-railway-entrypoint"]
