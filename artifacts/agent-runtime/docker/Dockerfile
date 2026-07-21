FROM node:24-bookworm-slim

ARG PNPM_VERSION=11.9.0

RUN npm install --global "pnpm@${PNPM_VERSION}" \
    && groupadd --gid 10001 sandbox \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin sandbox \
    && mkdir --parents /workspace \
    && chown sandbox:sandbox /workspace

WORKDIR /workspace
USER 10001:10001

CMD ["sleep", "infinity"]
