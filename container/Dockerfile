# syntax=docker/dockerfile:1.7
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun
#   - globally-installed Node CLIs (claude-code, agent-browser, vercel): pnpm + Node

FROM node:22-slim

# ---- Build-time arguments ----------------------------------------------------
# Pass --build-arg ENABLE_GPU=1 for CUDA/Vulkan GPU support
ARG ENABLE_GPU=0

# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Pin CLI versions for reproducibility. Bump deliberately — unpinned installs
# mean every rebuild silently picks up the latest and can break in lockstep
# across all users.
ARG CLAUDE_CODE_VERSION=2.1.121
ARG CODEX_VERSION=0.124.0
ARG AGENT_BROWSER_VERSION=latest
ARG VERCEL_VERSION=latest
ARG BUN_VERSION=1.3.12

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

# GPU packages: CUDA toolkit, Vulkan, X11/GL (only when ENABLE_GPU=1)
RUN if [ "$ENABLE_GPU" = "1" ]; then \
      apt-get update && apt-get install -y \
        cuda-toolkit-12-6 \
        libvulkan1 \
        libvulkan-dev \
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
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# agent-browser has a postinstall build script — pnpm skips these by default.
# Allowlist it via .npmrc so the install doesn't silently produce a broken
# package. Pinned versions so every rebuild is reproducible.
RUN --mount=type=cache,target=/root/.cache/pnpm \
    echo "only-built-dependencies[]=agent-browser" > /root/.npmrc && \
    echo "only-built-dependencies[]=@anthropic-ai/claude-code" >> /root/.npmrc && \
    pnpm install -g \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
        "agent-browser@${AGENT_BROWSER_VERSION}" \
        "vercel@${VERCEL_VERSION}" \
        "@openai/codex@${CODEX_VERSION}"

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

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Workspace + permissions -------------------------------------------------
RUN mkdir -p /workspace/group /workspace/global /workspace/extra && \
    chown -R node:node /workspace && \
    chmod 777 /home/node


USER node
WORKDIR /workspace/group

# tini is PID 1, reaps zombies, forwards signals cleanly. entrypoint.sh does
# `exec bun ...` so bun runs as tini's direct child.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
