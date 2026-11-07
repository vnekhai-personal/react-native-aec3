// The AEC3 configuration the module runs, and a canceller made with another, for a bench to compare
// against (README.md, "Measuring"). C++ only: Swift and JNI use rn_aec3.h.
#ifndef RN_AEC3_CONFIG_H
#define RN_AEC3_CONFIG_H

#include "api/audio/echo_canceller3_config.h"
#include "rn_aec3.h"

namespace rnaec3 {

webrtc::EchoCanceller3Config PhoneEchoCanceller3Config();

/**
 * What a canceller hands back: AEC3's whole output, or only its linear filter's, the microphone with the echo
 * it modelled subtracted and nothing suppressed (16 kHz microphone audio only).
 */
enum class Output { kFull, kLinear };

RnAec3* CreateEchoCanceller(int capture_rate_hz, int render_rate_hz,
                                         const webrtc::EchoCanceller3Config& config, Output output = Output::kFull);

}  // namespace rnaec3

#endif  // RN_AEC3_CONFIG_H
