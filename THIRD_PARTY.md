# Third-party components

react-native-aec3 is MIT ([LICENSE](./LICENSE)). It vendors, unmodified and trimmed to the files its builds use
(`vendor/`, listed with SHA-256s in `vendor/MANIFEST.json`):

- **WebRTC audio processing**, version 2.1 of PulseAudio's standalone packaging
  ([webrtc-audio-processing](https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing)), BSD-3-Clause,
  copyright The WebRTC project authors. License, authors and patent grant: `vendor/webrtc-audio-processing/COPYING`,
  `webrtc/LICENSE`, `webrtc/PATENTS`. The small third-party parts WebRTC itself bundles keep their own notices
  beside their code under `vendor/webrtc-audio-processing/webrtc/`.
- **Abseil**, version 20240722.0 ([abseil-cpp](https://github.com/abseil/abseil-cpp)), Apache-2.0, copyright
  The Abseil Authors. License: `vendor/abseil-cpp/LICENSE`; its privacy manifest ships in the iOS app's resources.

Copyright belongs to the respective authors.
