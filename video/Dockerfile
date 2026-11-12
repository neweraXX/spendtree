FROM mcr.microsoft.com/playwright:v1.49.1-noble

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/spendtree-video
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev --no-audit --no-fund --save-exact playwright@1.49.1

COPY record.mjs ./
COPY scenes/ ./scenes/

ENV HOME=/tmp
USER pwuser
CMD ["node", "/opt/spendtree-video/record.mjs"]
