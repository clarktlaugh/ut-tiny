# Sounds

Recorded sound files served at `/sounds/<file>`. Until a file exists, every sound is a
procedural placeholder rendered from its recipe in `src/audio/sounds.ts`.

To replace a placeholder:

1. Add the file here (`.ogg` preferred, mono, 48 kHz). It must be original or
   permissively licensed; no assets from Epic's games (docs/DESIGN.md §1).
2. List it in `SOUND_FILES` in `src/audio/sounds.ts`, keyed by sound id, for example
   `explosion: 'explosion.ogg'`. Announcer lines use `announcer.<line>`, for example
   `'announcer.firstBlood': 'announcer/first-blood.ogg'`.

`AudioSystem.loadFiles(fetch)` decodes the listed files and keeps the placeholder for
any file that fails to load.
