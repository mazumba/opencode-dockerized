# Plugin: image
# AVIF and WebP creation with vips
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-tools \
    && rm -rf /var/lib/apt/lists/*
