import { describe, expect, it } from "vitest";

import { createEchoCancellerWith as createEchoCanceller } from "../src/echoCanceller";
import { androidRouteReachesMic, iosOutputReachesMic } from "../src/routes";

import type { EchoCancellerReadings, NativeEchoCanceller } from "../src/native";

/** AEC3's stand-in: keeps what it was handed and halves the microphone, so its work shows in the output. */
class FakeAec implements NativeEchoCanceller {
  readonly calls: { capture: Float32Array; render: Float32Array }[] = [];
  released = false;
  throws = false;
  readingsNow: EchoCancellerReadings = {
    delayMs: null, echoReturnLossDb: null, echoReturnLossEnhancementDb: null,
  };

  process(capture: Float32Array, render: Float32Array): void {
    if (this.released) throw new Error("released");
    if (this.throws) throw new Error("WebRTC refused the audio (-6)");
    this.calls.push({ capture: capture.slice(), render: render.slice() });
    for (let i = 0; i < capture.length; i += 1) capture[i] = capture[i]! / 2;
  }

  readings(): EchoCancellerReadings {
    return this.readingsNow;
  }

  release(): void {
    this.released = true;
  }
}

/** A clock the test moves: the speaker's, in seconds. */
function setup({ native = true } = {}) {
  const made: FakeAec[] = [];
  const clock = { now: 0, ms: 0, latency: 0 };
  const failures: number[] = [];
  const canceller = createEchoCanceller({
    create: () => {
      if (!native) return null;
      const aec = new FakeAec();
      made.push(aec);
      return aec;
    },
    now: () => clock.now,
    outputLatency: () => clock.latency,
    clock: () => clock.ms,
    onFailure: () => failures.push(clock.now),
  });
  return { canceller, made, clock, failures };
}

/** 100 ms of microphone at 16 kHz, each sample its own index from `start`, so a test can tell them apart. */
function mic(start: number, length = 1_600) {
  return Float32Array.from({ length }, (_, i) => (start + i) / 1e6);
}

/** Reply audio at 24 kHz whose sample n is n, for reading back where it was laid. */
function ramp(length: number) {
  return Float32Array.from({ length }, (_, i) => i + 1);
}

describe("the echo canceller", () => {
  it("pairs each 10 ms of the microphone with the reply that played over the same span", () => {
    const { canceller, made, clock } = setup();
    // The reply starts at 1 s on the speaker's clock and plays for a second.
    canceller.scheduled(ramp(24_000), 1);
    // A buffer whose last sample was captured at 1.1 s arrives then: it covers 1.0–1.1 s.
    clock.now = 1.1;
    const out = canceller.process(mic(0), 16_000);
    expect(out).toHaveLength(1_600);
    const call = made[0]!.calls[0]!;
    expect(call.capture).toEqual(mic(0));
    // 100 ms of reply from its start: 2,400 samples at 24 kHz, sample 1 first.
    expect(call.render).toEqual(ramp(2_400));
    // Cancelled in place, and that is what goes on.
    expect(out[1]).toBeCloseTo(mic(0)[1]! / 2);

    // The next buffer continues where this one ended, whatever its own arrival jitter.
    clock.now = 1.215;
    canceller.process(mic(1_600), 16_000);
    expect(made[0]!.calls[1]!.render[0]).toBe(2_401);
    canceller.stop();
  });

  it("reads the reply as it left the speaker: its schedule plus the measured output latency, less 40 ms", () => {
    const { canceller, made, clock } = setup();
    canceller.scheduled(ramp(48_000), 1);
    // The platform measures 100 ms from the speaker's clock to the speaker: the reply is read 60 ms earlier.
    clock.latency = 0.1;
    clock.now = 1.2;
    canceller.process(mic(0), 16_000);
    // The buffer covers 1.1–1.2 s and reads the reply from 1.04 s: its sample 960.
    expect(made[0]!.calls[0]!.render[0]).toBe(961);
    expect(canceller.diagnostics().outputLatencyMs).toBe(100);
    canceller.stop();
  });

  it("pairs as before where the measured latency is within the headroom, or unknown", () => {
    const { canceller, made, clock } = setup();
    canceller.scheduled(ramp(24_000), 1);
    clock.latency = 0.03;
    clock.now = 1.1;
    canceller.process(mic(0), 16_000);
    expect(made[0]!.calls[0]!.render[0]).toBe(1);
    expect(canceller.diagnostics().outputLatencyMs).toBe(30);
    canceller.stop();

    const unknown = setup();
    unknown.canceller.scheduled(ramp(24_000), 1);
    unknown.clock.latency = Number.NaN;
    unknown.clock.now = 1.1;
    unknown.canceller.process(mic(0), 16_000);
    expect(unknown.made[0]!.calls[0]!.render[0]).toBe(1);
    expect(unknown.canceller.diagnostics()).not.toHaveProperty("outputLatencyMs");
    unknown.canceller.stop();
  });

  it("measures the latency afresh each time it places the microphone, as a new route moves it", () => {
    const { canceller, made, clock } = setup();
    canceller.scheduled(ramp(72_000), 0);
    clock.latency = 0.1;
    clock.now = 1.1;
    canceller.process(mic(0), 16_000);
    // Away from where the microphone hears the reply and back, now with 250 ms to the speaker.
    canceller.setActive(false);
    canceller.setActive(true);
    clock.latency = 0.25;
    clock.now = 2.1;
    canceller.process(mic(1_600), 16_000);
    // 2.0–2.1 s reads the reply from 1.79 s: its sample 42,960.
    expect(made[1]!.calls[0]!.render[0]).toBe(42_961);
    expect(canceller.diagnostics().outputLatencyMs).toBe(250);
    canceller.stop();
  });

  it("keeps an AEC3's measured latency when a paused microphone is placed again, so its echo stays put", () => {
    const { canceller, made, clock } = setup();
    canceller.scheduled(ramp(72_000), 0);
    clock.latency = 0.1;
    clock.now = 1.1;
    canceller.process(mic(0), 16_000);
    canceller.resumed();
    clock.latency = 0.3;
    clock.now = 2.1;
    canceller.process(mic(1_600), 16_000);
    // 2.0–2.1 s still reads the reply 60 ms earlier, from 1.94 s: its sample 46,560.
    expect(made[0]!.calls[1]!.render[0]).toBe(46_561);
    expect(canceller.diagnostics().outputLatencyMs).toBe(100);
    canceller.stop();
  });

  it("keeps the reply for microphone buffers still on their way when the JavaScript thread falls behind", () => {
    const { canceller, made, clock } = setup();
    canceller.scheduled(ramp(24_000), 0);
    clock.now = 0.1;
    canceller.process(mic(0), 16_000);
    // The thread stalls 3 s while the speaker plays on: a chunk scheduled then must not let go of the reply
    // the queued buffers, placed from 0.1 s on, still read.
    clock.now = 3.1;
    canceller.scheduled(ramp(24_000), 3);
    canceller.process(mic(1_600), 16_000);
    expect(made[0]!.calls[1]!.render[0]).toBe(2_401);
    canceller.stop();
  });

  it("passes silence for the reply where none plays, and none after the speaker dropped its queue", () => {
    const { canceller, made, clock } = setup();
    canceller.scheduled(ramp(24_000), 1);
    // 0.9–1.0 s, before the reply.
    clock.now = 1.0;
    canceller.process(mic(0), 16_000);
    expect(made[0]!.calls[0]!.render.every((sample) => sample === 0)).toBe(true);

    // An interruption at 1.05 s: nothing of the reply plays from then on.
    canceller.playbackStopped(1.05);
    clock.now = 1.1;
    canceller.process(mic(1_600), 16_000);
    const render = made[0]!.calls[1]!.render;
    expect(render.slice(0, 1_200)).toEqual(ramp(1_200));
    expect(render.slice(1_200).every((sample) => sample === 0)).toBe(true);
    canceller.stop();
  });

  it("moves a buffer back at once when it arrives sooner than its placement allows", () => {
    const { canceller, made, clock } = setup();
    canceller.scheduled(ramp(48_000), 0);
    // The first buffer arrived late (the session was starting): it was placed as if on time.
    clock.now = 0.5;
    canceller.process(mic(0), 16_000);
    // The next arrives only 20 ms later, so the first was captured earlier than it looked.
    clock.now = 0.52;
    canceller.process(mic(1_600), 16_000);
    expect(canceller.diagnostics().moves).toBe(1);
    // Placed to end on arrival: 0.42–0.52 s, at 24 kHz sample 10,080.
    expect(made[0]!.calls[1]!.render[0]).toBe(10_081);
    canceller.stop();
  });

  it("moves forward only when a whole window of buffers arrived late, never for a late burst", () => {
    const { canceller, clock } = setup();
    let at = 0.1;
    clock.now = at;
    canceller.process(mic(0), 16_000);
    // A 300 ms stall of the JavaScript thread: the buffers it held arrive together, then on time again.
    for (let i = 1; i <= 60; i += 1) {
      at += 0.1;
      clock.now = i >= 10 && i <= 12 ? 1.3 : at;
      canceller.process(mic(i * 1_600), 16_000);
    }
    expect(canceller.diagnostics().moves).toBe(0);

    // A microphone whose buffers keep coming 50 ms behind their samples for a whole window (5 s).
    for (let i = 61; i <= 160; i += 1) {
      at += 0.1;
      clock.now = at + 0.05;
      canceller.process(mic(i * 1_600), 16_000);
    }
    expect(canceller.diagnostics().moves).toBe(1);
    canceller.stop();
  });

  it("cancels whole 10 ms frames and carries the rest into the next buffer", () => {
    const { canceller, made, clock } = setup();
    canceller.scheduled(ramp(48_000), 0);
    clock.now = 0.0625;
    const first = canceller.process(mic(0, 1_000), 16_000);
    expect(first).toHaveLength(960);
    clock.now = 0.125;
    const second = canceller.process(mic(1_000, 1_000), 16_000);
    expect(second).toHaveLength(960);
    expect(made[0]!.calls[1]!.capture[0]).toBeCloseTo(960 / 1e6);
    // The carried samples' reply follows on from the first buffer's: 960 microphone samples, 1,440 reply.
    expect(made[0]!.calls[1]!.render[0]).toBe(made[0]!.calls[0]!.render[0]! + 1_440);
    canceller.stop();
  });

  it("stands by away from where the microphone hears the reply, and starts AEC3 over on coming back", () => {
    const { canceller, made, clock } = setup();
    clock.now = 0.1;
    canceller.process(mic(0), 16_000);
    canceller.setActive(false);
    expect(made[0]!.released).toBe(true);
    expect(canceller.isCancelling()).toBe(false);
    clock.now = 0.2;
    const passed = canceller.process(mic(1_600), 16_000);
    expect(passed).toEqual(mic(1_600));

    canceller.setActive(true);
    expect(made).toHaveLength(2);
    clock.now = 0.3;
    canceller.process(mic(3_200), 16_000);
    expect(made[1]!.calls).toHaveLength(1);
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({
      state: "on", frames: 20, bypassedMs: 100, restarts: 1,
    }));
    canceller.stop();
    expect(made[1]!.released).toBe(true);
  });

  it("starts over for a new microphone, and places a resumed one afresh", () => {
    const { canceller, made, clock } = setup();
    canceller.scheduled(ramp(240_000), 0);
    clock.now = 0.1;
    canceller.process(mic(0), 16_000);
    canceller.restart();
    expect(made).toHaveLength(2);
    expect(made[0]!.released).toBe(true);

    // Muted for 3 s: the resumed microphone's first buffer is placed where it arrives.
    clock.now = 0.2;
    canceller.process(mic(1_600), 16_000);
    canceller.resumed();
    clock.now = 3.3;
    canceller.process(mic(3_200), 16_000);
    expect(made[1]!.calls[1]!.render[0]).toBe(76_801);
    canceller.stop();
  });

  it("places a resumed microphone with the correction its first buffers found, so AEC3 sees no move", () => {
    const { canceller, made, clock } = setup();
    canceller.scheduled(ramp(96_000), 0);
    clock.now = 1.1;
    canceller.process(mic(0), 16_000);
    // The next buffer arrives 70 ms sooner than its placement allows, more than a placement may stay late
    // once a reply has played: the microphone was captured that much earlier.
    clock.now = 1.13;
    canceller.process(mic(1_600), 16_000);
    expect(made[0]!.calls[1]!.render[0]).toBe(24_721);
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({ moves: 1, movedMs: 70, maxMoveMs: 70 }));
    canceller.resumed();
    clock.now = 3.1;
    canceller.process(mic(0), 16_000);
    // Placed 70 ms earlier than its arrival says, as the pause changed nothing in how buffers arrive.
    expect(made[0]!.calls[2]!.render[0]).toBe(70_321);
    expect(canceller.diagnostics().moves).toBe(1);
    canceller.stop();
  });

  it("never places a resumed microphone later than its arrival proves: a forward correction is found again, not kept", () => {
    const { canceller, made, clock } = setup();
    // Every buffer of a 5 s window arrives 50 ms late: the microphone's clock runs slow, the placement moves forward.
    clock.now = 0.1;
    canceller.process(mic(0), 16_000);
    for (let i = 1; i <= 50; i += 1) {
      clock.now = 0.1 + i * 0.1 + 0.05;
      canceller.process(mic(i * 1_600), 16_000);
    }
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({ moves: 1, movedMs: 50 }));
    // Paused, then a reply is queued to start the moment the next buffer arrives: none of it can have reached
    // the microphone whose samples were all captured before that moment.
    canceller.resumed();
    clock.now = 9;
    canceller.scheduled(ramp(48_000), 9);
    canceller.process(mic(0), 16_000);
    const render = made[0]!.calls.at(-1)!.render;
    expect(render.every((sample) => sample === 0)).toBe(true);
    canceller.stop();
  });

  it("keeps a placement that proves late by less than 60 ms once a reply has played: only delay to AEC3", () => {
    const { canceller, made, clock } = setup();
    canceller.scheduled(ramp(72_000), 0);
    clock.now = 1.1;
    canceller.process(mic(0), 16_000);
    // The next buffer arrives 28 ms sooner than its placement allows, as a first buffer's lateness shows. A
    // move now would reset AEC3's filter for the reply it is cancelling: the placement stays, 28 ms late.
    clock.now = 1.172;
    canceller.process(mic(1_600), 16_000);
    expect(made[0]!.calls[1]!.render[0]).toBe(26_401);
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({ moves: 0, movedMs: 0 }));
    // One that arrives 70 ms sooner proves it later than a placement may stay: it moves, to the bound.
    clock.now = 1.23;
    canceller.process(mic(3_200), 16_000);
    // Placed to end on arrival: 1.13–1.23 s, at 24 kHz sample 27,120.
    expect(made[0]!.calls[2]!.render[0]).toBe(27_121);
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({ moves: 1, movedMs: 70 }));
    canceller.stop();
  });

  it("moves at once until AEC3 has heard a reply, queued or not, and again for a fresh one before it hears any", () => {
    const { canceller, made, clock } = setup();
    // No reply: the second buffer's 28 ms move the placement back at once.
    clock.now = 1.1;
    canceller.process(mic(0), 16_000);
    clock.now = 1.172;
    canceller.process(mic(1_600), 16_000);
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({ moves: 1, movedMs: 28 }));
    // A reply queued to play from 1.3 s: until AEC3 reads any of it, a move still costs nothing.
    canceller.scheduled(ramp(240_000), 1.3);
    clock.now = 1.244;
    canceller.process(mic(3_200), 16_000);
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({ moves: 2, movedMs: 56 }));
    // The next buffer reads the reply's first sounding samples: from here a buffer 28 ms sooner than the
    // placement allows leaves it where it is.
    clock.now = 1.344;
    canceller.process(mic(4_800), 16_000);
    clock.now = 1.416;
    canceller.process(mic(6_400), 16_000);
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({ moves: 2, movedMs: 56 }));
    // Back from an output the microphone does not hear while the reply plays on: the fresh AEC3 hears it from
    // its first frame, so a placement that proves 28 ms late stays.
    canceller.setActive(false);
    canceller.setActive(true);
    clock.now = 3.1;
    canceller.process(mic(0), 16_000);
    clock.now = 3.116;
    canceller.process(mic(1_600), 16_000);
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({ moves: 2, movedMs: 56 }));
    // The reply stopped and the microphone replaced: the new AEC3 has heard nothing, and moves at once again.
    canceller.playbackStopped(3.2);
    canceller.restart();
    clock.now = 4.1;
    canceller.process(mic(0), 16_000);
    clock.now = 4.172;
    canceller.process(mic(1_600), 16_000);
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({ moves: 3, movedMs: 84 }));
    expect(made).toHaveLength(3);
    canceller.stop();
  });

  it("holds the microphone after a resume while the reply sounds, for AEC3's delay and half a second", () => {
    const { canceller, made, clock } = setup();
    // Three seconds of reply from the session's start, sounding throughout.
    canceller.scheduled(ramp(72_000), 0);
    clock.now = 0.1;
    canceller.process(mic(0), 16_000);
    made[0]!.readingsNow = { delayMs: 120, echoReturnLossDb: 12, echoReturnLossEnhancementDb: 20 };
    canceller.resumed();
    // Back 1 s later: AEC3 missed the reply meanwhile, so for the delay plus 0.5 s the session hears silence.
    for (let i = 0; i < 6; i += 1) {
      clock.now = 1.2 + i * 0.1;
      expect(canceller.process(mic(i * 1_600), 16_000)).toEqual(new Float32Array(1_600));
    }
    clock.now = 1.8;
    const seventh = canceller.process(mic(9_600), 16_000);
    expect(seventh.subarray(0, 320)).toEqual(new Float32Array(320));
    // AEC3 heard every frame all along: the rest comes cancelled, not raw.
    expect(seventh[320]).toBeCloseTo(mic(9_600)[320]! / 2, 9);
    expect(made[0]!.calls).toHaveLength(8);
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({ heldMs: 620 }));
    canceller.stop();
  });

  it("holds for at least 0.6 s before AEC3 has found the echo, and at most 1 s", () => {
    const { canceller, made, clock } = setup();
    canceller.scheduled(ramp(240_000), 0);
    clock.now = 0.1;
    canceller.process(mic(0), 16_000);
    canceller.resumed();
    clock.now = 1.1;
    for (let i = 0; i < 8; i += 1) canceller.process(mic(0), 16_000);
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({ heldMs: 600 }));
    made[0]!.readingsNow = { delayMs: 900, echoReturnLossDb: 12, echoReturnLossEnhancementDb: 20 };
    canceller.resumed();
    clock.now = 3.1;
    for (let i = 0; i < 12; i += 1) canceller.process(mic(0), 16_000);
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({ heldMs: 1_600 }));
    canceller.stop();
  });

  it("passes the microphone after a resume where the reply has been silent, and holds where it just stopped", () => {
    const { canceller, made, clock } = setup();
    // A reply that ends at 1.0 s.
    canceller.scheduled(ramp(24_000), 0);
    clock.now = 0.1;
    canceller.process(mic(0), 16_000);
    made[0]!.readingsNow = { delayMs: 120, echoReturnLossDb: 12, echoReturnLossEnhancementDb: 20 };
    // Back at 1.05 s: the reply stopped 50 ms ago, within the 620 ms its echo still matters.
    canceller.resumed();
    for (let i = 0; i < 5; i += 1) {
      clock.now = 1.15 + i * 0.1;
      expect(canceller.process(mic(i * 1_600), 16_000)).toEqual(new Float32Array(1_600));
    }
    clock.now = 1.65;
    const sixth = canceller.process(mic(8_000), 16_000);
    // Held up to 620 ms after the reply's last sound at 1.0 s, then handed on.
    expect(sixth.subarray(0, 1_120)).toEqual(new Float32Array(1_120));
    expect(sixth[1_120]).toBeCloseTo(mic(8_000)[1_120]! / 2, 9);
    // Back long after the reply ended: nothing to hold.
    canceller.resumed();
    clock.now = 5;
    const later = canceller.process(mic(0), 16_000);
    expect(later[0]).toBeCloseTo(mic(0)[0]! / 2, 9);
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({ heldMs: 570 }));
    canceller.stop();
  });

  it("hands back every sample it held when a call fails, the remainder waiting for a frame included", () => {
    const { canceller, made, clock, failures } = setup();
    canceller.scheduled(ramp(48_000), 0);
    clock.now = 0.1;
    // 1,000 samples: 6 whole frames go to AEC3 and 40 samples wait for the next buffer.
    const first = canceller.process(mic(0, 1_000), 16_000);
    expect(first).toHaveLength(960);
    made[0]!.throws = true;
    clock.now = 0.1625;
    const second = canceller.process(mic(1_000, 1_000), 16_000);
    // The 40 held back plus the 1,000 that just arrived, as they came.
    expect(second).toHaveLength(1_040);
    expect(second).toEqual(mic(960, 1_040));
    expect(failures).toEqual([0.1625]);
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({ state: "failed" }));
    canceller.stop();
  });

  it("hands the failed call's audio back even when onFailure itself throws", () => {
    const made: FakeAec[] = [];
    const clock = { now: 0.1 };
    const canceller = createEchoCanceller({
      create: () => {
        const aec = new FakeAec();
        made.push(aec);
        return aec;
      },
      now: () => clock.now,
      onFailure: () => {
        throw new Error("the caller's callback is broken");
      },
    });
    canceller.scheduled(ramp(48_000), 0);
    expect(canceller.process(mic(0), 16_000)).toHaveLength(1_600);
    made[0]!.throws = true;
    clock.now = 0.2;
    expect(canceller.process(mic(1_600), 16_000)).toEqual(mic(1_600));
    clock.now = 0.3;
    // Nothing of the failed call is carried into the next one.
    expect(canceller.process(mic(3_200), 16_000)).toEqual(mic(3_200));
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({ state: "failed" }));
    canceller.stop();
  });

  it("gives up for the session when AEC3 fails, passing the microphone through as it came", () => {
    const { canceller, made, clock, failures } = setup();
    clock.now = 0.1;
    canceller.process(mic(0), 16_000);
    made[0]!.throws = true;
    clock.now = 0.2;
    canceller.process(mic(1_600), 16_000);
    expect(failures).toEqual([0.2]);
    expect(canceller.isCancelling()).toBe(false);
    clock.now = 0.3;
    expect(canceller.process(mic(3_200), 16_000)).toEqual(mic(3_200));
    // Coming back to the speaker does not bring a failed canceller back.
    canceller.setActive(false);
    canceller.setActive(true);
    expect(made).toHaveLength(1);
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({ state: "failed" }));
    canceller.stop();
  });

  it("makes no AEC3 for a new microphone while it stands by, and one when the reply is heard again", () => {
    const { canceller, made } = setup();
    canceller.setActive(false);
    canceller.restart();
    expect(made).toHaveLength(1);
    canceller.setActive(true);
    expect(made).toHaveLength(2);
    expect(canceller.diagnostics().restarts).toBe(1);
    canceller.stop();
    expect(made.every((aec) => aec.released)).toBe(true);
  });

  it("keeps AEC3's last readings until a fresh one has its own", () => {
    const { canceller, made, clock } = setup();
    made[0]!.readingsNow = { delayMs: 96, echoReturnLossDb: 12, echoReturnLossEnhancementDb: 20 };
    clock.now = 0.1;
    canceller.process(mic(0), 16_000);
    canceller.restart();
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({ delayMs: 96, echoReturnLossEnhancementDb: 20 }));
    canceller.stop();
  });

  it("starts the session without AEC3 where the module cannot make one, and reports it failed", () => {
    const failures: number[] = [];
    const canceller = createEchoCanceller({
      create: () => {
        throw new Error("WebRTC made no audio processing");
      },
      now: () => 0.1,
      outputLatency: () => 0,
      clock: () => 0,
      onFailure: () => failures.push(0),
    });
    expect(canceller.isCancelling()).toBe(false);
    expect(canceller.process(mic(0), 16_000)).toEqual(mic(0));
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({ state: "failed", frames: 0 }));
    // Reported once, as a failure during the session is.
    expect(failures).toEqual([0]);
    canceller.stop();
  });

  it("still starts, passing audio through, when AEC3 cannot be made and onFailure itself throws", () => {
    const canceller = createEchoCanceller({
      create: () => {
        throw new Error("WebRTC made no audio processing");
      },
      now: () => 0.1,
      onFailure: () => {
        throw new Error("the caller's callback is broken");
      },
    });
    expect(canceller.isCancelling()).toBe(false);
    expect(canceller.process(mic(0), 16_000)).toEqual(mic(0));
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({ state: "failed", frames: 0 }));
    canceller.stop();
  });

  it("refuses a rate AEC3 does not run at before anything is made: the caller's error, not a failure", () => {
    const failures: number[] = [];
    const made: number[] = [];
    expect(() =>
      createEchoCanceller({
        captureRate: 22_050,
        create: () => {
          made.push(1);
          return null;
        },
        now: () => 0,
        onFailure: () => failures.push(0),
      }),
    ).toThrow(RangeError);
    expect(() => createEchoCanceller({ renderRate: 44_000, now: () => 0 })).toThrow(/44000 Hz/);
    expect(made).toEqual([]);
    expect(failures).toEqual([]);
  });

  it("passes the microphone through where the build has no AEC3, or at a rate it does not run at", () => {
    const missing = setup({ native: false });
    expect(missing.canceller.process(mic(0), 16_000)).toEqual(mic(0));
    expect(missing.canceller.diagnostics()).toEqual(expect.objectContaining({ state: "unavailable", frames: 0 }));

    const { canceller, made } = setup();
    const at48 = mic(0, 4_800);
    expect(canceller.process(at48, 48_000)).toBe(at48);
    expect(made[0]!.calls).toHaveLength(0);
    expect(canceller.diagnostics().bypassedMs).toBe(100);
    canceller.stop();
  });

  it("reports AEC3's work and readings as numbers only, leaving out what it has not read yet", () => {
    const { canceller, made, clock } = setup();
    clock.now = 0.1;
    canceller.process(mic(0), 16_000);
    expect(canceller.diagnostics()).toEqual({
      state: "on", frames: 10, bypassedMs: 0, processingMs: 0,
      maxProcessingMs: 0, moves: 0, movedMs: 0, maxMoveMs: 0,
      restarts: 0, heldMs: 0,
    });
    made[0]!.readingsNow = { delayMs: 116, echoReturnLossDb: 1.234, echoReturnLossEnhancementDb: 30.456 };
    expect(canceller.diagnostics()).toEqual(expect.objectContaining({
      delayMs: 116, echoReturnLossDb: 1.23, echoReturnLossEnhancementDb: 30.46,
    }));
    canceller.stop();
  });
});

describe("where the reply comes back to the microphone", () => {
  it("on iOS, from the phone's own speaker and earpiece and from speakers on a cable", () => {
    for (const category of ["Speaker", "Receiver", "USBAudio", "HDMIOutput", "LineOut"]) expect(iosOutputReachesMic([category])).toBe(true);
  });

  it("on iOS, not from headphones, Bluetooth, car audio or AirPlay, where AEC3 would only hold the near end down", () => {
    for (const category of ["Headphones", "BluetoothHFP", "BluetoothA2DPOutput", "BluetoothLE", "CarAudio", "AirPlay"]) {
      expect(iosOutputReachesMic([category])).toBe(false);
    }
  });

  it("on iOS, where any output of a shared route is heard, the route is unknown, or iOS names a new output", () => {
    expect(iosOutputReachesMic(["Headphones", "Speaker"])).toBe(true);
    expect(iosOutputReachesMic([])).toBe(true);
    expect(iosOutputReachesMic(["Virtual"])).toBe(true);
  });

  it("on Android, from every route but a headset, Bluetooth's call link, a hearing aid or a car", () => {
    for (const route of ["builtinSpeaker", "builtinEarpiece", "usbDevice", "hdmi", "bleSpeaker", "other", null]) {
      expect(androidRouteReachesMic(route)).toBe(true);
    }
    for (const route of ["wiredHeadset", "wiredHeadphones", "usbHeadset", "bluetoothSco", "bleHeadset", "hearingAid", "bus"]) {
      expect(androidRouteReachesMic(route)).toBe(false);
    }
  });
});
