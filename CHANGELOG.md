# Changelog

All notable changes to this package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [SemVer](https://semver.org/). Until 1.0 the TypeScript contract may change in a minor
version; the vendored WebRTC release changes only in a minor, never a patch.

## 0.1.0 — 2026-11-07

First release: WebRTC's AEC3 (webrtc-audio-processing 2.1) as an Expo module for iOS and Android, run behind
the platform's own echo cancellation, with the TypeScript pairing of microphone and far-end audio on the
speaker's clock, route-aware standby, fail-open behaviour, session diagnostics, a Mac bench harness, the
vendoring script and an example app with a launch self-test.
