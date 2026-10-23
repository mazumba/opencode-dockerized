---
name: midi
description: MIDI and audio with Python and FluidSynth. Use when creating, parsing, or transforming MIDI files, analysing music (keys, chords, notation), rendering MIDI to WAV/MP3, or analysing audio.
---

The container is headless: there is no sound card and no notation renderer (no MuseScore or LilyPond). Write results to files.

## Choosing a library

| Task | Library | Notes |
|---|---|---|
| Raw messages, tempo maps, byte-exact edits | `mido` 1.3 | Times are delta **ticks**. Convert with `mido.tick2second`. |
| Notes in seconds: generate, quantise, transpose | `pretty_midi` 0.2 | `Instrument(program=0..127)` takes General MIDI programs. Drums use `is_drum=True`. |
| Theory: keys, chords, intervals, MusicXML | `music21` 10 | `converter.parse("x.mid").analyze("key")`. Calling `.show()` raises an error here. Use `.write("musicxml", fp=...)`, `.write("midi", fp=...)` or `.show("text")`. |
| Audio features: pitch, onsets, tempo, spectra | `librosa` 0.11 + `soundfile` | `numpy`, `scipy`, `pandas` and `matplotlib` are installed. Use `matplotlib.use("Agg")`. |

`miditoolkit` (REMI/tokenisation-style tick data) is also available.

## Rendering MIDI to audio

The only General MIDI SoundFont is `/usr/share/sounds/sf2/TimGM6mb.sf2` (6 MB, basic quality). `default-GM.sf2` points to it.

```sh
fluidsynth -ni -F out.wav -r 44100 /usr/share/sounds/sf2/TimGM6mb.sf2 in.mid   # options before the soundfont
ffmpeg -loglevel error -y -i out.wav -q:a 2 out.mp3
```

- From Python, `pretty_midi.PrettyMIDI(p).fluidsynth(fs=44100)` returns a mono NumPy array. Write it with `soundfile.write`.
- Run `timidity` with `-c /etc/timidity/timgm6mb.cfg`. Its default config points to a SoundFont that is not installed.

Verify by checking that the output is non-empty and has the expected duration: `soundfile.info("out.wav").duration`, or `pm.get_end_time()` for MIDI.
