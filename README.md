# react-native-aec3

WebRTC's AEC3 echo canceller for React Native voice agents, running on the phone behind the platform's own
echo cancellation, for the part of the agent's voice the platform canceller leaves in the microphone.

Turn on the platform canceller first (`iosVoiceProcessing: true`, `androidInputPreset: 'voiceCommunication'`
in react-native-audio-api). On a phone speaker it still lets the agent hear itself: iOS voice processing
leaks the opening of each reply before it converges, iOS echo-cancelled input leaves a steady residual a
streaming recognizer transcribes, and Android's canceller only references the voice-communication output
stream. This module takes what is left, with the exact far-end audio as its reference.

**For** apps that play the agent's audio themselves through an `AudioContext` (or any player that reports when
each chunk starts on its clock) and record through an `AudioRecorder`: a custom WebSocket agent, OpenAI
Realtime over WebSocket, Gemini Live, Pipecat over a socket. **Not for** LiveKit, Daily or any libwebrtc
transport: those own the playback and the canceller, and their WebRTC cannot be linked beside this module's on
iOS.

## Features

- An [Expo module](https://docs.expo.dev/modules/overview/): Swift on iOS, Kotlin and a small JNI bridge on
  Android, around a vendored, pinned [webrtc-audio-processing 2.1](https://gitlab.freedesktop.org/pulseaudio/webrtc-audio-processing)
  ([THIRD_PARTY.md](./THIRD_PARTY.md)).
- Pairs each 10 ms of microphone with the 10 ms of far-end audio that played over it, on the speaker's clock,
  with the platform's measured output latency; AEC3 finds the rest of the delay itself, up to about 0.5 s.
- Stands by on routes where the microphone cannot hear the speaker (headset, car, AirPlay) and starts over
  when the audio comes back.
- Fails open: if AEC3 cannot be made or throws, the session continues with the platform canceller alone.
  Builds without the module (Expo Go, web) behave the same.
- About 1 ms of CPU per 100 ms of microphone, 0.5 MB of memory per running canceller, 0.7 MB of iOS code
  and a 0.6 MB Android library.

## Installation

```sh
npm install react-native-aec3
```

The module itself needs only a player that tells you when each chunk starts on its clock and a recorder that
hands you `Float32Array` buffers; it imports nothing but Expo. The snippets below and the example use
[react-native-audio-api](https://github.com/software-mansion/react-native-audio-api) for both (`npm install
react-native-audio-api`), and its `AudioContext` clock, `outputLatency` and device info are what the route
helpers expect; any other player works if you supply the same.

Add the microphone permission in `app.json` (or through react-native-audio-api's config plugin), then
`npx expo prebuild`:

```json
{
  "expo": {
    "ios": { "infoPlist": { "NSMicrophoneUsageDescription": "Talk to the assistant." } },
    "android": { "permissions": ["android.permission.RECORD_AUDIO", "android.permission.MODIFY_AUDIO_SETTINGS"] }
  }
}
```

Requires the Expo modules runtime (`expo-modules-core`; bare React Native apps: `npx install-expo-modules`).
Tested with Expo SDK 58 / React Native 0.88. No other package that bundles libwebrtc may be in the app
(`react-native-webrtc`, the LiveKit, Daily, Stream, Agora and 100ms SDKs): WebRTC's symbols carry no version
and the iOS link would mix two copies.

## Usage

```
  your agent ──far-end chunks──▶ AudioContext ──▶ speaker ─╮
       │                              │                     │ room
       │        canceller.scheduled(samples, at) ◀──────────┤
       │        canceller.playbackStopped(at)               ▼
       ▼                                                 microphone
  speech recognizer ◀── canceller.process(buffer) ◀── platform canceller ◀── AudioRecorder
```

The contract: **tell the canceller every chunk you schedule and every time you drop the queue**, and run every
microphone buffer through it. A chunk you never report passes its echo through; a queue you drop on a barge-in
without `playbackStopped` makes the canceller hold the near end down against audio that never sounded; a `now`
that is not the context's clock means AEC3 never locks (`delayMs` stays 12).

### Minimal integration

```ts
import { AudioBufferSourceNode, AudioContext, AudioRecorder } from "react-native-audio-api";
import { createEchoCanceller } from "react-native-aec3";

// Rates AEC3 runs at: 8, 16, 24, 32, 44.1 or 48 kHz each. OpenAI Realtime is 24 kHz both ways.
const MIC_RATE = 16_000;
const REPLY_RATE = 24_000;

const context = new AudioContext({ sampleRate: REPLY_RATE, androidOutputProfile: "voiceCommunication" });
const canceller = createEchoCanceller({
  captureRate: MIC_RATE,
  renderRate: REPLY_RATE,
  now: () => context.currentTime,
  outputLatency: () => context.outputLatency ?? 0,
});

// 1. Report every chunk when you schedule it, with its start on the context's clock.
let nextAt = 0;
const playing = new Set<AudioBufferSourceNode>();
function play(samples: Float32Array<ArrayBuffer>) {
  const buffer = context.createBuffer(1, samples.length, REPLY_RATE);
  buffer.copyToChannel(samples, 0);
  const node = context.createBufferSource();
  node.buffer = buffer;
  node.connect(context.destination);
  const at = Math.max(nextAt, context.currentTime + 0.05);
  node.start(at);
  canceller.scheduled(samples, at);
  nextAt = at + samples.length / REPLY_RATE;
  playing.add(node);
  node.onended = () => {
    playing.delete(node);
    node.onended = null; // the library keeps the handler, and with it the node and its buffer, until cleared
  };
}

// 2. Report every time you drop the queue (a barge-in).
function stopPlayback() {
  for (const node of playing) {
    node.onended = null;
    node.stop();
  }
  playing.clear();
  nextAt = 0;
  canceller.playbackStopped(context.currentTime);
}

// 3. Run every microphone buffer through it, with the platform canceller in front.
const recorder = new AudioRecorder({ iosVoiceProcessing: true, androidInputPreset: "voiceCommunication" });
recorder.onAudioReady({ sampleRate: MIC_RATE, bufferLength: MIC_RATE / 10, channelCount: 1 }, ({ buffer }) => {
  const cleaned = canceller.process(buffer.getChannelData(0), buffer.sampleRate);
  if (cleaned.length > 0) sendToYourAgent(cleaned); // your code: the recognizer, the socket
});
```

`process` returns whole 10 ms frames and keeps the remainder for the next buffer. While the canceller stands
by, AEC3 has failed, or the build has no native module, it returns the buffer untouched. Its output lags the
input by 8 ms at 16 kHz.

### Full integration

Uses `context`, `canceller` and `recorder` from above. Run step 1 before creating them, step 2 before
`recorder.start()`, step 3 at the end.

```ts
import { AudioManager } from "react-native-audio-api";
import { addAndroidRouteListener, androidCommunicationRoute, androidRouteReachesMic, iosOutputReachesMic } from "react-native-aec3";
import { Platform } from "react-native";

// 1. The audio session: voice chat on iOS; on Android 12+ the communication session, whose output stream the
//    platform canceller references (the context's output profile above puts playback on that stream).
AudioManager.setSystemOptions({
  ios: { category: "playAndRecord", mode: "voiceChat", options: ["defaultToSpeaker", "allowBluetoothHFP"] },
  android: Platform.OS === "android" && Number(Platform.Version) >= 31 ? { mode: "inCommunication", communicationDevice: "speaker" } : undefined,
});
await AudioManager.setAudioSessionActivity(true);
if ((await AudioManager.requestRecordingPermissions()) !== "Granted") throw new Error("no microphone");

// 2. Stand by where the microphone cannot hear the speaker, and start over where it can again.
async function followRoute() {
  if (Platform.OS === "ios") {
    const info = await AudioManager.getDevicesInfo();
    canceller.setActive(iosOutputReachesMic(info.currentOutputs.map((device) => device.category)));
  } else {
    canceller.setActive(androidRouteReachesMic(androidCommunicationRoute()));
  }
}
const routeWatch = AudioManager.addSystemEventListener("routeChange", () => void followRoute());
const androidRoutes = addAndroidRouteListener((route) => canceller.setActive(androidRouteReachesMic(route)));
await followRoute();
await recorder.start();

// 3. Teardown, in this order.
await recorder.stop();
recorder.clearOnAudioReady(); // stop() keeps the callback for a reuse of the recorder
routeWatch.remove();
androidRoutes.remove();
console.log(canceller.diagnostics());
canceller.stop();
await context.close();
await AudioManager.setAudioSessionActivity(false);
```

## API

`createEchoCanceller(options)` → `EchoCanceller`. Options: `captureRate` (default 16 000), `renderRate`
(default 24 000), `now` (the speaker's clock in seconds, required), `outputLatency` (seconds, default 0),
`onFailure` (called once if AEC3 drops out). An unsupported rate throws a `RangeError`.

| method | when |
|---|---|
| `scheduled(samples, at)` | a chunk of far-end audio starts at `at` seconds on the speaker's clock (the array is copied) |
| `playbackStopped(at)` | the queue was dropped at `at` seconds |
| `process(samples, sampleRate)` | a microphone buffer; returns what to send in its place |
| `restart()` | you created a new `AudioRecorder`: AEC3 starts over, the new microphone is placed afresh |
| `resumed()` | you paused and resumed the recorder: placed afresh, and for 0.6–1 s the frames where the far end sounds are handed on as silence, because AEC3 missed what played meanwhile. To mute, drop the frames yourself instead and keep the recorder running |
| `setActive(reachesMic)` | the route changed: standing by passes audio through, coming back starts a fresh AEC3 |
| `isCancelling()` | AEC3 is running now: made, not failed, not standing by |
| `diagnostics()` | counts and levels only, below |
| `stop()` | the session ended |

Also exported: `iosOutputReachesMic(categories)` and `androidRouteReachesMic(route)` (which routes the
microphone hears); `androidCommunicationRoute()` and `addAndroidRouteListener(listener)` (Android only,
since react-native-audio-api reports no current output there; null and a no-op on iOS); `isAvailable()`;
`SUPPORTED_RATES` and `isSupportedRate(rate)`; `createNativeAec3(captureRate, renderRate)`, the raw AEC3
with `process(capture, render)` over whole 10 ms frames.

### Diagnostics

Log `diagnostics()` at the end of every session:

| field | meaning | healthy |
|---|---|---|
| `state` | `on`, `unavailable` (no module in this build), `failed` | `on` |
| `frames` | 10 ms frames cancelled | ~100 per second |
| `bypassedMs` | passed through while standing by, or at a rate other than `captureRate` | 0 on a speaker; the session's length on a headset |
| `processingMs`, `maxProcessingMs` | AEC3's time per 100 ms of microphone, and its slowest call | 0.5–1.2; several times that means an unoptimized build |
| `delayMs` | the echo's delay as AEC3 found it (floored to 4 ms) | 20–400; **12 means no lock** |
| `echoReturnLossDb`, `echoReturnLossEnhancementDb` | how far below the far end the echo arrived, and how much AEC3 removed | moved off −30 and 0.2, which mean no lock |
| `outputLatencyMs` | the platform's measured output latency at the last placement | 5–100 |
| `moves`, `movedMs`, `maxMoveMs`, `restarts`, `heldMs` | placement moves, AEC3s made afresh, audio held as silence after resumes | a few small moves early; one restart per route change |

Troubleshooting: **no lock** (12 / −30 / 0.2) means no echo AEC3 can model (a headset, or the residual of
iOS echo-cancelled input) or a wrong pairing (`now` not the context's clock, a chunk not reported, a wrong
`at`); on a quiet route stand by, since an AEC3 that never locks holds a quiet near end down for 6 s.
**Interruptions swallowed**: check `playbackStopped` is called on every barge-in, then trigger barge-in on
the cleaned signal only after 0.3–0.5 s of speech; before lock a near end quieter than the far end is
suppressed, and after lock a near end 5 dB above the echo loses about 6 dB, 15 dB above about 1.5 dB.
**Echo in the first second only**: two cold starts, the platform canceller's and AEC3's own (~0.2 s to lock,
then a short burst when it switches to its linear model); hold the first-turn trigger that long. **Echo after
every unmute**: you pause the recorder to mute; drop the frames instead.

## How it works

AEC3 runs behind the platform canceller: the microphone is recorded through the platform's own echo
cancellation, and WebRTC's audio processing (AEC3 in full plus the high-pass filter, no noise suppression or
gain control) takes what that leaves, with the exact far-end audio as its reference.

Every scheduled chunk is laid on a timeline at its start on the context's clock; `playbackStopped` cuts it.
The first microphone buffer is assumed captured just before it arrived, each later one placed one buffer-length
after the previous; a buffer that arrives earlier than that moves the placement earlier, at once until AEC3 has
heard any far end and afterwards only when more than 60 ms early, because shrinking the delay AEC3 locked on
resets its filter for about a second. For every 10 ms of microphone, AEC3 is given the 10 ms of far end that
left the speaker at the same moment, its scheduled time plus the measured output latency, handed over 40 ms
early because AEC3 finds an echo that arrives after its reference and never one before it. All of this pairing
exists because the canceller runs outside the audio engine; inside an engine that owns playback and capture on
one clock, AEC3 is a tap on the output path with no pairing at all, and this package is offered as the
reference for that port.

**Configuration.** WebRTC's defaults with one change: `ep_strength.default_gain` 0.5 instead of 1, which
costs a near end who speaks before AEC3 locks less (1–6 dB instead of 3–16 dB in a five-room bench) while
cancelling the cold leak as well. The suppressor stays on: with a speech recognizer as the consumer, the linear
filter alone lets most of the far end's words through, at the price of some double-talk loss. Both live in
`cpp/rn_aec3.cc`; the bench in `bench/` is how to judge a change (how to build and run it is at the top of
`bench/harness.cc`).

## Limitations

- Before lock, a near end quieter than the far end is suppressed; on a route with no echo, for 6 s. Stand by
  where there is no echo.
- Echo louder than the near end holds the near end down while AEC3 sorts them apart; with the platform
  canceller in front this does not happen on a phone speaker.
- AEC3 needs the echo's delay to hold: an echo that drifts by milliseconds every buffer (an emulator's audio
  injection) is never learned. Judge it with a real echo, on a device.
- Measured so far on iPhones and on iOS and Android emulators; not yet on a physical Android device.
- Old architecture untested; Expo Go and web have no native module and pass audio through.

## Example app

`example/` runs a self-test at launch with no microphone or speaker (3 s of synthetic echo through the raw
AEC3: whether `process` wrote the result back, what it removed, the delay it found), then plays a synthetic
reply through the speaker every few seconds and shows the microphone before and after AEC3.

```sh
cd example && npm install
npx expo run:ios --device     # or: npx expo run:android --device
```

## Feedback

Bugs, with the `diagnostics()` of a session that shows them, ideas and questions: open an issue in the
repository. Changes are listed in [CHANGELOG.md](./CHANGELOG.md).

## License

MIT ([LICENSE](./LICENSE)). The vendored WebRTC audio processing module, its bundled parts and Abseil keep
their own licenses: see [THIRD_PARTY.md](./THIRD_PARTY.md).
