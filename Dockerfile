FROM oven/bun:1.4.3-slim

WORKDIR /app

ENV PORT=20129 \
    HOST=0.0.0.0 \
    OPENCODE_CACHE_DIR=/data/cache \
    OPENCODE_BRIDGE_STATE_DIR=/data/state

COPY --chown=bun:bun . .

# `COPY --chown` chowns the copied files but not the directories that contain
# them, so /app stays root-owned while the process runs as `bun`. The
# self-updater stages its temp files next to their targets inside __dirname,
# so it needs a writable /app or every update dies with EACCES.
RUN mkdir -p /data/cache /data/state \
    && chown -R bun:bun /data /app

USER bun

EXPOSE 20129

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||'20129')+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["bun", "server.js"]
