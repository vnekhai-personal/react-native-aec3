// A screen that plays a synthetic "reply" through the phone's speaker every few seconds, records the
// microphone through the platform's echo canceller, runs react-native-aec3 behind it, and shows what each
// stage leaves of the reply in the microphone. Try it on a device: a simulator has no acoustic path unless
// its host plays through speakers near its microphone.
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { AudioContext, AudioManager, AudioRecorder } from "react-native-audio-api";
import { addAndroidRouteListener, androidRouteReachesMic, androidCommunicationRoute, createEchoCanceller, createNativeAec3, iosOutputReachesMic, isAvailable } from "react-native-aec3";

import type { EchoCancellerDiagnostics, NativeEchoCanceller } from "react-native-aec3";

const MIC_RATE = 16_000;
const REPLY_RATE = 24_000;
const REPLY_SECONDS = 2;
const REPLY_EVERY_SECONDS = 4;

/** A speech-like reply: noise bursts under a 4 Hz syllable envelope, so AEC3 has something with structure to model. */
function synthReply(): Float32Array<ArrayBuffer> {
  const samples = new Float32Array(REPLY_RATE * REPLY_SECONDS);
  let seed = 7;
  let lowPassed = 0;
  for (let i = 0; i < samples.length; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = seed / 2 ** 32 - 0.5;
    lowPassed += 0.15 * (noise - lowPassed);
    const t = i / REPLY_RATE;
    const syllable = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t);
    samples[i] = 0.5 * syllable * lowPassed * 4;
  }
  return samples;
}

const dbfs = (samples: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i]! * samples[i]!;
  return 10 * Math.log10(sum / Math.max(1, samples.length) + 1e-20);
};

interface Levels {
  /** Median microphone level while the reply played, before and after AEC3, in dBFS. */
  rawPlayingDb: number | null;
  cancelledPlayingDb: number | null;
  quietDb: number | null;
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
};

/**
 * A self-test of the native module with no microphone or speaker: 3 s of synthetic far end at 24 kHz, a microphone
 * at 16 kHz carrying its echo 100 ms late at −20 dB, processed in 100 ms chunks through the raw AEC3. It proves
 * that `process` changes the array in place on this build (Expo hands some parameter types to native code as
 * copies, which would throw the cancellation away), that AEC3 locks on the echo, and how much it removes.
 */
interface SelfTest {
  inPlace: boolean;
  inputDb: number;
  outputDb: number;
  delayMs: number | null;
  erleDb: number | null;
  error: string | null;
}

function runSelfTest(): SelfTest | null {
  // Created inside the guarded block: a native factory that throws is a self-test result, not a crash of the screen.
  let aec: NativeEchoCanceller | null = null;
  try {
    aec = createNativeAec3(MIC_RATE, REPLY_RATE);
    if (aec === null) return null;
    const seconds = 3;
    const far = new Float32Array(REPLY_RATE * seconds);
    let seed = 11;
    let lowPassed = 0;
    for (let i = 0; i < far.length; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      lowPassed += 0.15 * (seed / 2 ** 32 - 0.5 - lowPassed);
      const t = i / REPLY_RATE;
      // 0.3 s of silence first: an echo that starts within AEC3's first 0.2 s is taken for the room's noise floor.
      const burst = t >= 0.3 && Math.floor(t * 3) % 2 === 1 ? 0.5 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) : 0;
      far[i] = burst * lowPassed * 4;
    }
    const farAt16 = (n: number) => {
      const x = (n * REPLY_RATE) / MIC_RATE;
      const i = Math.floor(x);
      return (far[i] ?? 0) * (1 - (x - i)) + (far[i + 1] ?? 0) * (x - i);
    };
    const mic = new Float32Array(MIC_RATE * seconds);
    for (let n = 0; n < mic.length; n += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      mic[n] = 0.1 * farAt16(n - Math.round(0.1 * MIC_RATE)) + 0.04 * farAt16(n - Math.round(0.135 * MIC_RATE)) + 0.0005 * (seed / 2 ** 32 - 0.5);
    }
    const chunk = MIC_RATE / 10;
    let inPlace = false;
    let inputPower = 0;
    let outputPower = 0;
    let counted = 0;
    for (let c = 0; c < seconds * 10; c += 1) {
      const capture = mic.slice(c * chunk, (c + 1) * chunk);
      const before = capture.slice();
      // A view into the far end, not a copy: the offset path is what a real session uses.
      const render = far.subarray(c * (REPLY_RATE / 10), (c + 1) * (REPLY_RATE / 10));
      aec.process(capture, render);
      if (!inPlace) inPlace = capture.some((value, k) => value !== before[k]);
      if (c >= 20) {
        for (let k = 0; k < chunk; k += 1) {
          inputPower += before[k]! * before[k]!;
          outputPower += capture[k]! * capture[k]!;
        }
        counted += chunk;
      }
    }
    const readings = aec.readings();
    return {
      inPlace,
      inputDb: 10 * Math.log10(inputPower / counted + 1e-20),
      outputDb: 10 * Math.log10(outputPower / counted + 1e-20),
      delayMs: readings.delayMs,
      erleDb: readings.echoReturnLossEnhancementDb,
      error: null,
    };
  } catch (error) {
    return { inPlace: false, inputDb: 0, outputDb: 0, delayMs: null, erleDb: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    aec?.release();
  }
}

/** Everything a running session set up, undone in reverse order by `stop`. */
interface Session {
  readonly canceller: ReturnType<typeof createEchoCanceller>;
  stop(): Promise<void>;
}

export default function App() {
  const [running, setRunning] = useState(false);
  const [levels, setLevels] = useState<Levels>({ rawPlayingDb: null, cancelledPlayingDb: null, quietDb: null });
  const [diagnostics, setDiagnostics] = useState<EchoCancellerDiagnostics | null>(null);
  const [route, setRoute] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [selfTest, setSelfTest] = useState<SelfTest | null | undefined>(undefined);
  const session = useRef<Session | null>(null);
  /** A start or a stop in progress: a second tap meanwhile does nothing. */
  const busy = useRef(false);
  /** A stop (or the unmount) asked for while a start was still in progress: the start undoes itself at its end. */
  const stopRequested = useRef(false);

  async function start() {
    if (busy.current || session.current !== null) return;
    busy.current = true;
    stopRequested.current = false;
    // Thrown after an await when Stop was tapped or the screen went away meanwhile: the catch undoes what was set
    // up so far and acquires nothing more.
    const STOPPED = Symbol("stopped");
    const checkpoint = () => {
      if (stopRequested.current) throw STOPPED;
    };
    // What has been set up so far, undone in reverse if the start fails part-way or the session stops.
    const cleanups: (() => Promise<unknown> | void)[] = [];
    const undo = async () => {
      for (const cleanup of cleanups.splice(0).reverse()) {
        try {
          await cleanup();
        } catch {
          // Nothing to do about a teardown that fails; the rest still runs.
        }
      }
    };
    try {
      AudioManager.setSystemOptions({
        ios: { category: "playAndRecord", mode: "voiceChat", options: ["defaultToSpeaker", "allowBluetoothHFP"] },
        // The communication session exists from Android 12: below it setAudioSessionActivity would reject.
        android: Platform.OS === "android" && Number(Platform.Version) >= 31 ? { mode: "inCommunication", communicationDevice: "speaker" } : undefined,
      });
      // The options take effect when the session is activated; on Android that is the communication session
      // whose output stream the platform's echo canceller references.
      await AudioManager.setAudioSessionActivity(true);
      cleanups.push(() => AudioManager.setAudioSessionActivity(false));
      checkpoint();
      const granted = await AudioManager.requestRecordingPermissions();
      if (granted !== "Granted") throw new Error("Microphone permission was not granted");
      checkpoint();

      const context = new AudioContext({ sampleRate: REPLY_RATE, androidOutputProfile: "voiceCommunication" });
      cleanups.push(() => context.close());
      const canceller = createEchoCanceller({
        captureRate: MIC_RATE,
        renderRate: REPLY_RATE,
        now: () => context.currentTime,
        outputLatency: () => context.outputLatency ?? 0,
        onFailure: () => console.warn("AEC3 dropped out"),
      });
      cleanups.push(() => canceller.stop());
      const reply = synthReply();
      let playingUntil = 0;
      const raw: number[] = [];
      const cancelled: number[] = [];
      const quiet: number[] = [];

      const playReply = () => {
        const buffer = context.createBuffer(1, reply.length, REPLY_RATE);
        buffer.copyToChannel(reply, 0);
        const node = context.createBufferSource();
        node.buffer = buffer;
        node.connect(context.destination);
        const at = context.currentTime + 0.1;
        node.start(at);
        canceller.scheduled(reply, at);
        playingUntil = at + REPLY_SECONDS;
      };

      const followRoute = async () => {
        if (Platform.OS === "ios") {
          const info = await AudioManager.getDevicesInfo();
          const categories = info.currentOutputs.map((device) => device.category);
          setRoute(categories.join(", ") || "unknown");
          canceller.setActive(iosOutputReachesMic(categories));
        } else {
          const current = androidCommunicationRoute();
          setRoute(current ?? "unknown");
          canceller.setActive(androidRouteReachesMic(current));
        }
      };
      const routeWatch = AudioManager.addSystemEventListener("routeChange", () => void followRoute());
      cleanups.push(() => routeWatch.remove());
      const androidRoutes = addAndroidRouteListener((current) => {
        setRoute(current ?? "unknown");
        canceller.setActive(androidRouteReachesMic(current));
      });
      cleanups.push(() => androidRoutes.remove());
      await followRoute();
      checkpoint();

      const recorder = new AudioRecorder({ iosVoiceProcessing: true, androidInputPreset: "voiceCommunication" });
      const listening = recorder.onAudioReady({ sampleRate: MIC_RATE, bufferLength: MIC_RATE / 10, channelCount: 1 }, ({ buffer }) => {
        const samples = buffer.getChannelData(0);
        const before = dbfs(samples);
        const after = canceller.process(samples, buffer.sampleRate);
        // Judge each buffer by the reply's schedule, with the output latency and the echo path behind it.
        if (context.currentTime < playingUntil + 0.3 && context.currentTime > playingUntil - REPLY_SECONDS + 0.5) {
          raw.push(before);
          if (after.length > 0) cancelled.push(dbfs(after));
        } else if (context.currentTime > playingUntil + 1) {
          quiet.push(before);
        }
      });
      if (listening.status === "error") throw new Error(`The recorder refused the callback: ${listening.message}`);
      // stop() keeps the subscription for a reuse of the recorder; cleared, or the callback keeps this session alive.
      cleanups.push(() => recorder.clearOnAudioReady());
      const started = await recorder.start();
      if (started.status === "error") throw new Error(`The recorder did not start: ${started.message}`);
      cleanups.push(() => recorder.stop());
      checkpoint();

      const replies = setInterval(playReply, REPLY_EVERY_SECONDS * 1_000);
      cleanups.push(() => clearInterval(replies));
      playReply();
      const report = setInterval(() => {
        setLevels({ rawPlayingDb: median(raw), cancelledPlayingDb: median(cancelled), quietDb: median(quiet) });
        setDiagnostics(canceller.diagnostics());
      }, 1_000);
      cleanups.push(() => clearInterval(report));

      checkpoint();
      session.current = { canceller, stop: undo };
      setProblem(null);
      setRunning(true);
    } catch (error) {
      await undo();
      if (error !== STOPPED) setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      busy.current = false;
    }
  }

  async function stop() {
    if (busy.current) {
      stopRequested.current = true;
      return;
    }
    if (session.current === null) return;
    busy.current = true;
    const current = session.current;
    session.current = null;
    try {
      await current.stop();
      setDiagnostics(current.canceller.diagnostics());
    } finally {
      busy.current = false;
      setRunning(false);
    }
  }

  useEffect(() => {
    setSelfTest(runSelfTest());
    return () => void stop();
  }, []);

  const line = (label: string, value: string | number | null | undefined) => (
    <View style={styles.row} key={label}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value === null || value === undefined ? "—" : typeof value === "number" ? value.toFixed(1) : value}</Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.title}>react-native-aec3</Text>
      <Text style={styles.hint}>
        {isAvailable() ? "Native module loaded." : "No native module in this build: rebuild after prebuild."} A reply plays every{" "}
        {REPLY_EVERY_SECONDS} s. Hold the phone as you would in a voice session and compare the microphone before and after AEC3.
      </Text>
      <Pressable style={[styles.button, running && styles.buttonStop]} onPress={() => void (running ? stop() : start())}>
        <Text style={styles.buttonText}>{running ? "Stop" : "Start"}</Text>
      </Pressable>
      {problem !== null && <Text style={styles.problem}>{problem}</Text>}
      <Text style={selfTest === null || selfTest?.error !== null && selfTest?.error !== undefined || selfTest?.inPlace === false ? styles.problem : styles.hint}>
        {selfTest === undefined
          ? "Self-test running…"
          : selfTest === null
            ? "Self-test: no native module in this build."
            : selfTest.error !== null
              ? `Self-test failed: ${selfTest.error}`
              : `Self-test: ${selfTest.inPlace ? "in place ✓" : "OUTPUT NOT WRITTEN BACK ✗"}, synthetic echo ${selfTest.inputDb.toFixed(1)} → ${selfTest.outputDb.toFixed(1)} dBFS, delay ${selfTest.delayMs ?? "—"} ms, ERLE ${selfTest.erleDb?.toFixed(1) ?? "—"} dB`}
      </Text>
      {line("output route", route)}
      {line("mic while reply plays, before AEC3 (dBFS)", levels.rawPlayingDb)}
      {line("mic while reply plays, after AEC3 (dBFS)", levels.cancelledPlayingDb)}
      {line("mic in silence (dBFS)", levels.quietDb)}
      {diagnostics !== null && (
        <>
          {line("state", diagnostics.state)}
          {line("frames cancelled", diagnostics.frames)}
          {line("AEC3 ms per 100 ms", diagnostics.processingMs)}
          {line("delay found (ms)", diagnostics.delayMs)}
          {line("echo return loss (dB)", diagnostics.echoReturnLossDb)}
          {line("enhancement (dB)", diagnostics.echoReturnLossEnhancementDb)}
          {line("output latency (ms)", diagnostics.outputLatencyMs)}
          {line("placement moves", `${diagnostics.moves} (${diagnostics.movedMs} ms)`)}
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 20, gap: 8, backgroundColor: "#fff" },
  title: { fontSize: 24, fontWeight: "600", marginTop: 12 },
  hint: { color: "#444", marginBottom: 8 },
  problem: { color: "#b42318", marginBottom: 8 },
  button: { backgroundColor: "#1f6feb", padding: 14, borderRadius: 10, alignItems: "center", marginBottom: 12 },
  buttonStop: { backgroundColor: "#b42318" },
  buttonText: { color: "#fff", fontSize: 18, fontWeight: "600" },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  label: { color: "#333", flexShrink: 1 },
  value: { fontVariant: ["tabular-nums"], fontWeight: "500" },
});
