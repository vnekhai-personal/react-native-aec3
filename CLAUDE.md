# CLAUDE.md

`react-native-aec3` is WebRTC's AEC3 echo canceller as an Expo module for React Native voice agents, run on the
phone behind the platform's own echo cancellation with the far-end audio the app plays as its reference. The
README is the user's guide. This file is the layout, the invariants and the commands, and nothing else.

## Layout

| path | what |
|---|---|
| `src/echoCanceller.ts` | all policy: the far end on a timeline at the speaker's clock, each microphone buffer placed by arrival, standby, the resume hold, fail-open, diagnostics |
| `src/sharedBuffers.ts` | the one place JavaScript meets native memory: copies through the native-owned buffers |
| `src/native.ts` | the Expo module binding; `src/routes.ts`, `src/rates.ts`, `src/sampleTimeline.ts` are pure helpers |
| `cpp/` | the C interface over WebRTC's AEC3 (`rn_aec3.h`, `.cc`), its configuration, and `sources.cmake`, what every build compiles from `vendor/` |
| `ios/`, `ReactNativeAec3.podspec` | the Swift module and its build |
| `android/` | the Kotlin module with the route reader, the JNI bridge, the CMake build |
| `vendor/` | webrtc-audio-processing 2.1 and Abseil 20240722.0, trimmed, hashed in `MANIFEST.json` ([THIRD_PARTY.md](./THIRD_PARTY.md)) |
| `scripts/vendor.mjs` | re-derives `vendor/` from the pinned archives |
| `bench/` | the module's C++ built for a Mac, with a harness over recorded audio |
| `example/` | an Expo app: a launch self-test with no microphone or speaker, then a speaker-and-microphone screen |
| `__tests__/` | vitest, including the native contract: source checks, the vendor manifest, the pffft rename list |

Audio crosses the boundary one way: a canceller owns a capture and a render buffer and shares them with
JavaScript as `ArrayBuffer`s over the same memory; JavaScript copies a chunk in, calls `process(frames)`, and
copies the result out. The C layer runs WebRTC's `AudioProcessing` with AEC3 in full and the high-pass filter,
`AnalyzeReverseStream` of each render frame before `ProcessStream` of the capture frame.

## Invariants

1. Native code never takes a pointer, a length or an offset from JavaScript; it checks a frame count against
   the size it allocated. Expo sizes a typed array by JavaScript properties a script can shadow, and its iOS
   `ArrayBuffer` parameter copies a JavaScript-owned buffer. Pinned by `__tests__/native.test.ts`.
2. `process` is a synchronous `Function`, never an `AsyncFunction`: JavaScript waits, so nothing else touches
   the shared buffers meanwhile.
3. AEC3's readings are read after every frame: WebRTC's queue of one keeps the first update after a read and
   drops the rest.
4. `vendor/` is upstream's, never edited by hand; a fix of ours goes in `cpp/`. Every pffft function is renamed
   in the podspec, because react-native-audio-api compiles its own pffft into the same iOS app and the linker
   silently keeps one of two copies of a name.
5. The pairing's constants (60 ms early tolerance, 40 ms latency headroom, 0.6–1 s resume hold,
   `default_gain` 0.5) are measured; one changes only with a bench or device run that shows why.
6. Fail open: an AEC3 that cannot be made or throws is released, `onFailure` fires once and is isolated, the
   failed call hands its audio back as it came, every later `process` passes through.
7. Echo is judged with a real echo on a device, or one built on the microphone's own sample clock; an echo
   timed by buffer arrival, or an emulator's audio injection, drifts and AEC3 cannot learn it.

## Commands

```sh
npm install
npm test               # vitest
npm run typecheck
npm run build          # tsc → build/
npm run vendor:check   # re-derives vendor/ from the pinned archives (Xcode + Android NDK, ~2 min)
npm pack               # the tarball to install into example/ while testing the working tree
```

```sh
# the example, Release so the bundle is embedded and no Metro is needed on a simulator
cd example && npm install && npx expo prebuild
xcodebuild -workspace ios/AEC3Example.xcworkspace -scheme AEC3Example -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/build/derived build
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

```sh
# the bench: mono float32, mic at 16 kHz, far end at 24 kHz, sample-aligned; start with 0.3 s of silence
cd bench && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --target harness
build/harness mic.f32 ref.f32 out.f32 [default_gain=0.5] [num_filters=5] [linear=0|1]
```

If prebuild's `pod install` fails on the locale: `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install` in `example/ios`.

## Before a change is done

- `npm test` and `npm run typecheck` pass; `npm run vendor:check` too if `vendor/`, `cpp/sources.cmake` or
  the podspec's lists changed.
- A native change (`cpp/`, `ios/`, `android/`, the podspec, the CMake files) is proven before it is committed:
  `npm pack`, then `cd example && npm install ../react-native-aec3-0.1.0.tgz`, which replaces the published
  version the example depends on with the working tree for this checkout only (`example/package-lock.json` is
  gitignored, so the swap never reaches a commit); Release builds for both platforms; the self-test read on an
  iOS Simulator and an Android emulator. A build that compiles can still discard AEC3's output; one did. Read the
  `BUILD SUCCEEDED` line, not a wrapper's exit code.
- A change to the pairing gets a vitest that fails on the old code and passes on the new.

## Updating the vendored sources

1. Change the pins in `scripts/vendor.mjs`; bring `cpp/sources.cmake` and the podspec's per-architecture lists
   in line with the release's `webrtc/**/meson.build` (an unresolved `absl::` symbol names an Abseil file to add).
2. `npm run vendor`, build both platforms, run the self-test on both, update [THIRD_PARTY.md](./THIRD_PARTY.md).
3. Check `nm -gU libReactNativeAec3.a` shares no WebRTC, Abseil or pffft name with any other static library in
   the iOS build's products (libc++ and Swift runtime names are shared with every pod).

## References

- Expo module API: https://docs.expo.dev/modules/module-api/
- react-native-audio-api, what the README snippets and the example call: https://docs.swmansion.com/react-native-audio-api/
- AEC3 upstream, for how it behaves (the copy under `vendor/` is the one that runs): https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_processing/aec3/
