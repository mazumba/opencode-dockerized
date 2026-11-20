# Plugin: image
# AVIF and WebP creation with vips. libheif-plugin-aomenc is the AV1 encoder
# that AVIF saving needs; since trixie libheif only recommends it.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-tools \
    libheif-plugin-aomenc \
    && rm -rf /var/lib/apt/lists/*
