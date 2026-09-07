# syntax=docker/dockerfile:1.7
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun, bind-mounted at /app/src by host
#   - globally-installed Node CLIs (claude-code, agent-browser): pnpm + Node
#
# Source is never baked in — /app/src is a per-group bind mount provided at
# runtime (see src/container-runner.ts; writable, so an agent can modify its
# own runner). Source-only changes never require an image rebuild.

FROM node:22-slim

# ---- Build-time arguments ----------------------------------------------------
# Pass --build-arg ENABLE_GPU=1 for CUDA/Vulkan GPU support
ARG ENABLE_GPU=0

# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Pin versions for reproducibility. Bump deliberately — unpinned installs mean
# every rebuild silently picks up the latest and can break in lockstep across
# all users. The global Node CLIs (claude-code, agent-browser, claude-trace,
# codex) are pinned in cli-tools.json so a skill can add one with a json-merge;
# Bun (the runtime) is pinned here because it installs from a different source.
ARG BUN_VERSION=1.4.0

# Enable contrib + non-free + non-free-firmware so per-group container_configs
# can install packages like nvidia-cuda-toolkit (in non-free) without surprise
# "no installation candidate" failures.
RUN sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources

# Conditionally add NVIDIA CUDA repository (Debian bookworm)
RUN if [ "$ENABLE_GPU" = "1" ]; then \
      apt-get update && apt-get install -y wget gnupg \
      && wget -q https://developer.download.nvidia.com/compute/cuda/repos/debian12/x86_64/cuda-keyring_1.1-1_all.deb \
      && dpkg -i cuda-keyring_1.1-1_all.deb \
      && rm cuda-keyring_1.1-1_all.deb \
      && apt-get update; \
    fi

# ---- System dependencies -----------------------------------------------------
# tini: correct PID 1 / signal forwarding so outbound.db writes finalize on
# SIGTERM instead of being orphaned by the shell entrypoint.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libgbm1 \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libasound2 \
        libpangocairo-1.0-0 \
        libcups2 \
        libdrm2 \
        libxshmfence1 \
        # Build tools
        g++ \
        clang \
        cmake \
        ninja-build \
        pkg-config \
        zip \
        # Python (for codegen, coverage, scripting)
        python3 \
        python3-venv \
        python3-pip \
        # Test/coverage
        lcov \
        # Utilities
        ca-certificates \
        curl \
        jq \
        git \
        sudo \
        tmux \
        tini \
        unzip \
        socat \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
        apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# LLVM apt repo — versioned clang-format-NN (slang CI pins clang-format-17) is
# not in Debian bookworm default repos. Add official apt.llvm.org so per-group
# container_config apt installs (packages_apt) resolve it.
RUN curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key -o /usr/share/keyrings/apt-llvm.asc \
    && echo "deb [signed-by=/usr/share/keyrings/apt-llvm.asc] http://apt.llvm.org/bookworm/ llvm-toolchain-bookworm-17 main" > /etc/apt/sources.list.d/llvm-toolchain-17.list

# GPU packages: CUDA toolkit, Vulkan, X11/GL (only when ENABLE_GPU=1)
# libglvnd0 is load-bearing for Vulkan: the nvidia container runtime injects
# the driver (nvidia_icd.json + libGLX_nvidia.so.0) at runtime, but that ICD's
# vk_icdGetInstanceProcAddr returns NULL for vkCreateInstance unless the GLVND
# dispatch libs (libGLdispatch.so.0) are present — yielding a confusing
# ERROR_INCOMPATIBLE_DRIVER / "found no drivers". It's pulled in transitively
# by libgl1-mesa-dev today; list it explicitly so a future dep change can't
# silently break GPU Vulkan.
RUN if [ "$ENABLE_GPU" = "1" ]; then \
      apt-get update && apt-get install -y \
        cuda-toolkit-12-6 \
        libvulkan1 \
        libvulkan-dev \
        libglvnd0 \
        libx11-dev \
        libxrandr-dev \
        libgl1-mesa-dev \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# CUDA environment (harmless no-op when GPU not installed)
ENV PATH="/usr/local/cuda-12.6/bin:${PATH}"
ENV LD_LIBRARY_PATH="/usr/local/cuda-12.6/lib64:${LD_LIBRARY_PATH}"

# Allow node user to install packages without password (apt-get only, not dpkg)
RUN echo "node ALL=(ALL) NOPASSWD: /usr/bin/apt-get, /usr/bin/apt" > /etc/sudoers.d/node-apt \
    && chmod 0440 /etc/sudoers.d/node-apt

# Chromium path for agent-browser / Playwright consumers
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Belt-and-braces: prevent Playwright's postinstall from downloading its own
# ~300MB Chromium. We've already installed the system one above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---- GitHub CLI ---------------------------------------------------------------
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# ---- uv (Python package manager) + claude-code-transcripts -------------------
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
    && uv tool install --python-preference system claude-code-transcripts \
    && chmod -R a+rX /root /root/.local \
    && ln -sf /root/.local/bin/claude-code-transcripts /usr/local/bin/claude-code-transcripts

# ---- Bun runtime -------------------------------------------------------------
# Install via the official script (handles multi-arch detection), then move
# the binary to /usr/local/bin so the non-root `node` user can execute it.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# ---- pnpm + global Node CLIs -------------------------------------------------
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"
# Pin pnpm to match the host (package.json packageManager). pnpm 11 stopped
# honoring `only-built-dependencies[]=` in .npmrc for global installs, which
# silently skips claude-code's native-binary postinstall and agent-browser's
# bin chmod — the agent then crashes at runtime with "native binary not
# installed". Keep this in lockstep with package.json's `packageManager`.
ARG PNPM_VERSION=10.34.5
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# The npm bundled with node:22-slim (10.9.8) vendors tar <7.5.19, which
# carries a fixable critical (GHSA-23hp-3jrh-7fpw) that the publish gate
# refuses to ship. Patch-level bump only. Drop this once the base image
# ships npm >= 10.9.9.
ARG NPM_VERSION=10.9.9
RUN npm install -g npm@${NPM_VERSION}

# Global Node CLIs the agent invokes at runtime live in cli-tools.json so a
# skill can add one with a json-merge instead of editing this Dockerfile.
# install-cli-tools.sh installs each via pnpm (pinned), writing the per-tool
# only-built-dependencies opt-ins it reads from the manifest.
#
# codex is in that manifest too, as of the F01 fix. It used to be a second,
# hand-written `pnpm install -g` step here, duplicated verbatim in
# Dockerfile.derived under a "KEEP THIS IN LOCKSTEP" comment — a drift hazard
# the two files had to be manually reconciled against. One manifest, one
# installer, one pin.
COPY cli-tools.json install-cli-tools.sh /tmp/
RUN --mount=type=cache,target=/root/.cache/pnpm \
    sh /tmp/install-cli-tools.sh /tmp/cli-tools.json

# pi has no native MCP: NanoClaw's tools reach the pi provider via the
# pi-mcp-adapter extension, referenced by ABSOLUTE PATH from settings.json
# `extensions` (PI_MCP_ADAPTER_ENTRY, read by providers/pi.ts). Install it into
# a fixed, flat node_modules (exact pin, no build scripts) so pi loads it
# OFFLINE at runtime — no npm fetch on first spawn and no reliance on pi's
# internal package-dir layout. Only needed when the `pi` provider is used.
ARG PI_MCP_ADAPTER_VERSION=2.27.0
ENV PI_MCP_ADAPTER_ENTRY=/opt/pi-ext/node_modules/pi-mcp-adapter/index.ts
RUN mkdir -p /opt/pi-ext && cd /opt/pi-ext \
    && printf '{"name":"pi-ext","private":true}\n' > package.json \
    && npm install --no-audit --no-fund --ignore-scripts "pi-mcp-adapter@${PI_MCP_ADAPTER_VERSION}" \
    && chmod -R a+rX /opt/pi-ext

# Codex lifecycle hooks go in the MANAGED config layer. A hook in the user layer
# (~/.codex/hooks.json) needs per-hook content-hash trust before it may fire and
# is skipped SILENTLY without it — and our --rm containers can never accumulate
# that trust, so user-layer hooks are a permanent no-op. See container/
# codex-hooks.toml for the full rationale and the measurements behind it.
COPY codex-hooks.toml /etc/codex/requirements.toml

# ---- agent-runner ------------------------------------------------------------
WORKDIR /app

# Copy manifest + lockfile first so the install layer caches independently of
# source edits.
COPY agent-runner/package.json agent-runner/bun.lock ./

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile && \
    rm -f node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude

# Source. Bun runs TS directly — no tsc build step. The host remounts this
# path at runtime via `src/container-runner.ts` so source edits on the host
# take effect without rebuilding the image; the baked copy is the fallback.
COPY agent-runner/ ./

# ---- ncl CLI wrapper ----------------------------------------------------------
# Actual script lives in the mounted source at /app/src/cli/ncl.ts.
RUN printf '#!/bin/sh\nexec bun /app/src/cli/ncl.ts "$@"\n' > /usr/local/bin/ncl && \
    chmod +x /usr/local/bin/ncl

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Workspace + permissions -------------------------------------------------
RUN mkdir -p /workspace/agent /workspace/shared /workspace/extra && \
    chown -R node:node /workspace && \
    chmod 777 /home/node

# Drop setuid-root from the binaries Debian ships (mount, su, passwd, ...). The
# agent runs unprivileged and needs none of them.
RUN find / -xdev -perm -4000 -type f -exec chmod u-s {} + || true

USER node
WORKDIR /workspace/agent

# Only applies to a bare `docker run` — the host spawn overrides ENTRYPOINT and
# passes --init instead (see hardeningArgs in src/container-runner.ts).
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]

# ---- Provenance labels -------------------------------------------------------
# LAST on purpose. An ARG invalidates every layer below it, so declaring these
# up with the other build-args would make an otherwise-cached rebuild redo
# `bun install` and the pnpm global CLIs on every existing install, for two
# pieces of metadata. Labels have no filesystem effect, so they cost nothing here.
#
# Which lockfile the baked /app/node_modules came from: /app/src is mounted from
# the host checkout at every spawn, so an image and a checkout whose lockfiles
# disagree fail as a missing module inside a `--rm` container with no logs.
# container/pull.sh checks this before retagging. build.sh passes it; a bare
# `docker build` leaves it empty, which the pull path treats as unverifiable.
#
# image-source defaults to `local` so anything built from this file is honest
# unless its builder says otherwise — the retag cannot forge it after the fact.
ARG AGENT_RUNNER_LOCK_SHA256=
LABEL dev.nanoclaw.agent-runner-lock-sha256="${AGENT_RUNNER_LOCK_SHA256}"
ARG IMAGE_SOURCE=local
LABEL dev.nanoclaw.image-source="${IMAGE_SOURCE}"
