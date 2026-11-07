// The Kotlin EchoCanceller's native half: rn_aec3.h over JNI. The audio sits in direct ByteBuffers the
// Kotlin side owns and shares with JavaScript, so nothing is copied here and no address comes from JavaScript.
#include <jni.h>

#include <cstdint>

#include "rn_aec3.h"

namespace {

RnAec3* Canceller(jlong handle) { return reinterpret_cast<RnAec3*>(handle); }

}  // namespace

extern "C" {

JNIEXPORT jlong JNICALL Java_com_reactnativeaec3_EchoCanceller_nativeCreate(JNIEnv*, jclass, jint capture_rate,
                                                                                jint render_rate) {
  return reinterpret_cast<jlong>(rn_aec3_create(capture_rate, render_rate));
}

JNIEXPORT jint JNICALL Java_com_reactnativeaec3_EchoCanceller_nativeCaptureFrame(JNIEnv*, jclass, jlong handle) {
  return rn_aec3_capture_frame(Canceller(handle));
}

JNIEXPORT jint JNICALL Java_com_reactnativeaec3_EchoCanceller_nativeRenderFrame(JNIEnv*, jclass, jlong handle) {
  return rn_aec3_render_frame(Canceller(handle));
}

/**
 * Returns 0, WebRTC's error code, -1 where a buffer is not a direct one, or -2 where a buffer is smaller than
 * the frames need. Both buffers are the canceller's own, sized at creation; the capacity check is the floor
 * under any mistake above.
 */
JNIEXPORT jint JNICALL Java_com_reactnativeaec3_EchoCanceller_nativeProcess(JNIEnv* env, jclass, jlong handle,
                                                                                jobject capture, jobject render,
                                                                                jint frames) {
  auto* mic = static_cast<float*>(env->GetDirectBufferAddress(capture));
  auto* reply = static_cast<const float*>(env->GetDirectBufferAddress(render));
  if (mic == nullptr || reply == nullptr) return -1;
  RnAec3* canceller = Canceller(handle);
  const jlong mic_needed = static_cast<jlong>(frames) * rn_aec3_capture_frame(canceller) * sizeof(float);
  const jlong reply_needed = static_cast<jlong>(frames) * rn_aec3_render_frame(canceller) * sizeof(float);
  if (frames < 0 || env->GetDirectBufferCapacity(capture) < mic_needed || env->GetDirectBufferCapacity(render) < reply_needed) return -2;
  return rn_aec3_process(canceller, mic, reply, frames);
}

/** Fills `out` with delay, echo return loss and its enhancement, in that order. */
JNIEXPORT void JNICALL Java_com_reactnativeaec3_EchoCanceller_nativeStats(JNIEnv* env, jclass, jlong handle,
                                                                              jdoubleArray out) {
  RnAec3Stats stats;
  rn_aec3_stats(Canceller(handle), &stats);
  const jdouble values[3] = {stats.delay_ms, stats.echo_return_loss_db, stats.echo_return_loss_enhancement_db};
  env->SetDoubleArrayRegion(out, 0, 3, values);
}

JNIEXPORT void JNICALL Java_com_reactnativeaec3_EchoCanceller_nativeDestroy(JNIEnv*, jclass, jlong handle) {
  rn_aec3_destroy(Canceller(handle));
}

}  // extern "C"
