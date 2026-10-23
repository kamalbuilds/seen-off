FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY worker/requirements.txt worker/requirements.txt
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r worker/requirements.txt \
    && /opt/venv/bin/python -c "import aiortc, aiohttp, numpy, PIL"
COPY src src
# The public replay demo (fly.demo.toml): recorded days, their frames and the Qwen3-VL readings recorded on them.
COPY simulator/days simulator/days
COPY simulator/days.json simulator/replay.ts simulator/webhook-simulator.ts simulator/qwen3-vl-reads.json simulator/
COPY scripts scripts
COPY worker worker
COPY package.json ./
ENV WHEP_PYTHON=/opt/venv/bin/python NODE_ENV=production
# The ledger, frames, evidence and the sealed Ring token live in /app/data: mount the persistent volume there.
CMD ["node", "src/main.ts"]
