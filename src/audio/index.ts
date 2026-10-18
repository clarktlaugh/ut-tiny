/**
 * Audio (docs/DESIGN.md §8.4): buses, positional sources driven by sim
 * events, placeholder sounds and AudioContext resume.
 *
 * Wiring (done by the app / match flow packet):
 *
 * ```ts
 * const backend = new ThreeAudioBackend();
 * camera.add(backend.listener);
 * scene.add(backend.root);
 * const audio = new AudioSystem(backend, { volume: settings.volume });
 * resumeOnGesture(window, backend.listener.context);
 * session.onTick((events, state) => audio.handleTick(events, state, session.localPawnId));
 * settingsStore.subscribe((s) => audio.setVolume(s.volume));
 * ```
 */
export {
  AudioSystem,
  DEFAULT_MAX_VOICES,
  type AudioBackend,
  type AudioSystemOptions,
  type VoiceHandle,
} from './audioSystem';
export { BUSES, BUS_TRIM, busGains, type Bus } from './buses';
export {
  cuesForEvent,
  cuesForEvents,
  EXPLOSION_SOUNDS,
  FIRE_SOUNDS,
  HITSCAN_IMPACT,
  PICKUP_SOUNDS,
  LAND_HARD_SPEED,
  LAND_SILENT_SPEED,
  type CueContext,
  type SoundCue,
} from './eventSounds';
export { RESUME_EVENTS, resumeAudio, resumeOnGesture, type ResumableContext } from './resume';
export {
  DISTANCE_MODEL,
  SOUND_FILES,
  SOUND_IDS,
  SOUNDS,
  announcerSoundId,
  soundDef,
  soundUrl,
  type SoundDef,
  type SoundId,
} from './sounds';
export { renderSynth, type SynthLayer, type Waveform } from './synth';
export { ThreeAudioBackend, type ThreeAudioBackendOptions } from './threeBackend';
