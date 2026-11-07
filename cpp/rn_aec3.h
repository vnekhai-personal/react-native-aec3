// WebRTC's AEC3, from webrtc-audio-processing 2.1, behind a C interface Swift and JNI call. The
// microphone's audio is cancelled in place 10 ms at a time, each 10 ms after the far-end audio that played
// over the same 10 ms.
#ifndef RN_AEC3_H
#define RN_AEC3_H

#ifdef __cplusplus
extern "C" {
#endif

typedef struct RnAec3 RnAec3;

/**
 * AEC3's readings as of the last `rn_aec3_process`, each NaN before the first. Until AEC3 has found the
 * echo they hold its starting values: a 12 ms delay, a loss of -30 dB and an enhancement of 0.2 dB.
 */
typedef struct {
  /** How far behind the far-end audio its echo reaches the microphone, as AEC3 found it. */
  double delay_ms;
  /** How far below the far-end audio the echo reaches the microphone. */
  double echo_return_loss_db;
  /** How much of the echo AEC3 removes. */
  double echo_return_loss_enhancement_db;
} RnAec3Stats;

/**
 * A canceller for microphone audio at `capture_rate_hz` and far-end audio at `render_rate_hz`: 8, 16, 24,
 * 32, 44.1 or 48 kHz each. Null when it cannot be made.
 */
RnAec3* rn_aec3_create(int capture_rate_hz, int render_rate_hz);

/** Samples in 10 ms of microphone audio, and in 10 ms of far-end audio. */
int rn_aec3_capture_frame(const RnAec3* canceller);
int rn_aec3_render_frame(const RnAec3* canceller);

/**
 * Cancels `frames` 10 ms frames of mono microphone audio in place, each after the 10 ms of mono far-end
 * audio at the same place in `render`. Returns 0, or WebRTC's error code for the first frame it refused;
 * the frames before that one stay cancelled. Both buffers are the caller's: `capture` is read and written,
 * and `render` read, only during the call, and nothing keeps a pointer to either after it returns.
 */
int rn_aec3_process(RnAec3* canceller, float* capture, const float* render, int frames);

void rn_aec3_stats(RnAec3* canceller, RnAec3Stats* stats);

void rn_aec3_destroy(RnAec3* canceller);

#ifdef __cplusplus
}
#endif

#endif  // RN_AEC3_H
