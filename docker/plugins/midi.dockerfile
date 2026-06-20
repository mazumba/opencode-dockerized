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
