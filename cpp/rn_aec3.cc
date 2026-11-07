#include "rn_aec3.h"

#include <array>
#include <cstdint>
#include <limits>
#include <memory>
#include <new>
#include <optional>
#include <vector>

#include "api/audio/audio_processing.h"
#include "api/audio/echo_canceller3_config.h"
#include "api/audio/echo_control.h"
#include "api/scoped_refptr.h"
#include "rn_aec3_config.h"
#include "modules/audio_processing/aec3/echo_canceller3.h"

namespace {

/** AEC3 made with the configuration it is handed, where APM would make it with its default. */
class Aec3Factory : public webrtc::EchoControlFactory {
 public:
  explicit Aec3Factory(const webrtc::EchoCanceller3Config& config) : config_(config) {}

  std::unique_ptr<webrtc::EchoControl> Create(int sample_rate_hz, int num_render_channels,
                                              int num_capture_channels) override {
    return std::make_unique<webrtc::EchoCanceller3>(config_, std::nullopt, sample_rate_hz,
                                                    num_render_channels, num_capture_channels);
  }

 private:
  const webrtc::EchoCanceller3Config config_;
};

bool SupportedRate(int rate) {
  return rate == 8000 || rate == 16000 || rate == 24000 || rate == 32000 || rate == 44100 || rate == 48000;
}

template <typename T>
double Reading(const std::optional<T>& value) {
  return value ? static_cast<double>(*value) : std::numeric_limits<double>::quiet_NaN();
}

}  // namespace

struct RnAec3 {
  rtc::scoped_refptr<webrtc::AudioProcessing> apm;
  webrtc::StreamConfig capture;
  webrtc::StreamConfig render;
  std::vector<float> out;
  /** Hands back AEC3's linear filter output in place of its whole output (`rnaec3::Output::kLinear`). */
  bool linear = false;
  /**
   * AEC3's readings as of the last frame. APM hands them over through a queue of one that keeps the first
   * update after each read and drops the rest, so they are read after every frame: read only when asked, they
   * were those of just after the read before (a session on the iOS Simulator reported no echo found while AEC3
   * cancelled it with a 216 ms delay), and read once per call they are the first frame's.
   */
  webrtc::AudioProcessingStats latest;
};

namespace rnaec3 {

webrtc::EchoCanceller3Config PhoneEchoCanceller3Config() {
  webrtc::EchoCanceller3Config config;
  // Until AEC3 has found the echo it assumes one as loud as the far end (gain 1), and so held a near end
  // who spoke early in a session's first reply 3–16 dB down over the platform canceller's leftovers. At 0.5
  // that was 1–6 dB, with a cold canceller's leak cancelled as at 1; WebRTC's own trials try 0.1, which let
  // more of it through (README.md, "What was measured").
  config.ep_strength.default_gain = 0.5f;
  return config;
}

RnAec3* CreateEchoCanceller(int capture_rate_hz, int render_rate_hz,
                                         const webrtc::EchoCanceller3Config& aec3, Output output) {
  if (!SupportedRate(capture_rate_hz) || !SupportedRate(render_rate_hz)) return nullptr;
  // APM exports the linear filter's output at 16 kHz only.
  const bool linear = output == Output::kLinear;
  if (linear && capture_rate_hz != 16000) return nullptr;
  // AEC3 in full and the high-pass filter, with no noise suppression or gain control: the platform's
  // capture chain has its own.
  webrtc::AudioProcessing::Config config;
  config.echo_canceller.enabled = true;
  config.echo_canceller.mobile_mode = false;
  config.high_pass_filter.enabled = true;
  config.noise_suppression.enabled = false;
  config.gain_controller1.enabled = false;
  config.gain_controller2.enabled = false;
  config.echo_canceller.export_linear_aec_output = linear;
  // APM only makes room for the linear output; AEC3, made by our factory, must be told to fill it.
  webrtc::EchoCanceller3Config echo_config = aec3;
  echo_config.filter.export_linear_aec_output = linear;
  webrtc::AudioProcessingBuilder builder;
  builder.SetConfig(config);
  builder.SetEchoControlFactory(std::make_unique<Aec3Factory>(echo_config));
  auto* canceller = new (std::nothrow) RnAec3{
      builder.Create(), webrtc::StreamConfig(capture_rate_hz, 1), webrtc::StreamConfig(render_rate_hz, 1), {}, linear};
  if (canceller == nullptr) return nullptr;
  if (!canceller->apm) {
    delete canceller;
    return nullptr;
  }
  canceller->out.resize(canceller->capture.num_frames());
  return canceller;
}

}  // namespace rnaec3

extern "C" {

RnAec3* rn_aec3_create(int capture_rate_hz, int render_rate_hz) {
  return rnaec3::CreateEchoCanceller(capture_rate_hz, render_rate_hz, rnaec3::PhoneEchoCanceller3Config());
}

int rn_aec3_capture_frame(const RnAec3* canceller) {
  return static_cast<int>(canceller->capture.num_frames());
}

int rn_aec3_render_frame(const RnAec3* canceller) {
  return static_cast<int>(canceller->render.num_frames());
}

int rn_aec3_process(RnAec3* canceller, float* capture, const float* render,
                                  int frames) {
  const size_t capture_frame = canceller->capture.num_frames();
  const size_t render_frame = canceller->render.num_frames();
  float* out = canceller->out.data();
  for (int frame = 0; frame < frames; ++frame) {
    // The reply's 10 ms first, then the microphone's 10 ms over the same span, as WebRTC's own callers do.
    const float* reply[1] = {render + frame * render_frame};
    int result = canceller->apm->AnalyzeReverseStream(reply, canceller->render);
    if (result != 0) return result;
    float* mic = capture + frame * capture_frame;
    const float* in[1] = {mic};
    float* cancelled[1] = {out};
    result = canceller->apm->ProcessStream(in, canceller->capture, canceller->capture, cancelled);
    if (result != 0) return result;
    if (canceller->linear) {
      std::array<float, 160> linear[1];
      if (!canceller->apm->GetLinearAecOutput(rtc::ArrayView<std::array<float, 160>>(linear, 1))) return -1;
      for (size_t i = 0; i < capture_frame; ++i) mic[i] = linear[0][i];
      canceller->latest = canceller->apm->GetStatistics();
      continue;
    }
    for (size_t i = 0; i < capture_frame; ++i) mic[i] = out[i];
    // After every frame, not once per call: with several frames per call the readings would be those after
    // the call's first frame (the queue keeps the first update after a read and drops the rest).
    canceller->latest = canceller->apm->GetStatistics();
  }
  return 0;
}

void rn_aec3_stats(RnAec3* canceller, RnAec3Stats* stats) {
  const webrtc::AudioProcessingStats& readings = canceller->latest;
  stats->delay_ms = Reading(readings.delay_ms);
  stats->echo_return_loss_db = Reading(readings.echo_return_loss);
  stats->echo_return_loss_enhancement_db = Reading(readings.echo_return_loss_enhancement);
}

void rn_aec3_destroy(RnAec3* canceller) { delete canceller; }

}  // extern "C"
