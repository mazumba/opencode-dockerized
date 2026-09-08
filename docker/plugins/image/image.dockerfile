# Plugin: image
# Image handling: vips re-encoding, ExifTool metadata inspection, ClamAV scanning
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-tools \
    libimage-exiftool-perl \
    clamav \
    clamav-freshclam \
    && sed -i 's/^NotifyClamd/#NotifyClamd/' /etc/clamav/freshclam.conf \
    && rm -rf /var/lib/apt/lists/*
