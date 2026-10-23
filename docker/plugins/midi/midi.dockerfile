# Plugin: midi
# System packages for audio/MIDI synthesis and processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ffmpeg \
    fluidsynth \
    libfluidsynth-dev \
    timidity \
    libasound2 \
    libsndfile1 \
    python3-pip

# The timidity package's default config sources fluidr3_gm.cfg, whose SoundFont
# (fluid-soundfont-gm) is not installed. Point it at the bundled TimGM6mb
# SoundFont instead; fail the build if the expected line is not there.
RUN sed -i 's|^source /etc/timidity/fluidr3_gm.cfg$|source /etc/timidity/timgm6mb.cfg|' /etc/timidity/timidity.cfg && \
    grep -qx 'source /etc/timidity/timgm6mb.cfg' /etc/timidity/timidity.cfg

# Python MIDI/music stack
RUN python3 -m pip install --break-system-packages --upgrade pip setuptools wheel && \
    python3 -m pip install --break-system-packages \
      mido \
      pretty_midi \
      miditoolkit \
      music21 \
      pyfluidsynth \
      midi2audio \
      numpy \
      scipy \
      matplotlib \
      pandas \
      librosa \
      soundfile \
      jupyterlab
