# Plugin: excel
# Apt package for reading and writing .xlsx files
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-openpyxl
