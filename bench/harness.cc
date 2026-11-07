// The module's echo canceller over recorded audio, on a Mac. Build:
//   cd bench && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --target harness
// Run:
//   build/harness <mic.f32> <ref.f32> <out.f32> [key=value ...]
// mic: mono float32 at 16 kHz; ref: mono float32 at 24 kHz, the far-end audio that played over the same span,
// sample-aligned 10 ms frame by 10 ms frame. Writes the cancelled microphone to out.f32 and prints one JSON
// line: per-frame processing time and AEC3's last readings. key=value: default_gain=<gain>, num_filters=<n>,
// linear=0|1 (1 hands back AEC3's linear filter output alone, nothing suppressed). Start a signal with at least
// 0.3 s of silence: an echo already present in AEC3's first 0.2 s is taken for the room's noise floor.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "api/audio/echo_canceller3_config.h"
#include "rn_aec3.h"
#include "rn_aec3_config.h"

namespace {

constexpr int kCaptureRate = 16000;
constexpr int kRenderRate = 24000;

std::vector<float> ReadFloats(const char* path) {
  std::vector<float> data;
  FILE* file = std::fopen(path, "rb");
  if (!file) {
    std::fprintf(stderr, "cannot open %s\n", path);
    std::exit(2);
  }
  float buffer[4096];
  size_t read;
  while ((read = std::fread(buffer, sizeof(float), 4096, file)) > 0) data.insert(data.end(), buffer, buffer + read);
  std::fclose(file);
  return data;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 4) {
    std::fprintf(stderr, "usage: harness mic.f32 ref.f32 out.f32 [default_gain=<gain>] [num_filters=<n>] [linear=1]\n");
    return 2;
  }
  webrtc::EchoCanceller3Config config = rnaec3::PhoneEchoCanceller3Config();
  rnaec3::Output output = rnaec3::Output::kFull;
  for (int i = 4; i < argc; ++i) {
    const char* eq = std::strchr(argv[i], '=');
    const std::string key = eq ? std::string(argv[i], eq - argv[i]) : std::string(argv[i]);
    const float value = eq ? std::strtof(eq + 1, nullptr) : 0;
    if (key == "default_gain") config.ep_strength.default_gain = value;
    else if (key == "num_filters") config.delay.num_filters = static_cast<size_t>(value);
    else if (key == "linear") output = value != 0 ? rnaec3::Output::kLinear : rnaec3::Output::kFull;
    else {
      std::fprintf(stderr, "unknown setting %s\n", argv[i]);
      return 2;
    }
  }
  std::vector<float> mic = ReadFloats(argv[1]);
  const std::vector<float> ref = ReadFloats(argv[2]);
  RnAec3* canceller = rnaec3::CreateEchoCanceller(kCaptureRate, kRenderRate, config, output);
  if (!canceller) {
    std::fprintf(stderr, "create failed\n");
    return 1;
  }
  const int capture_frame = rn_aec3_capture_frame(canceller);
  const int render_frame = rn_aec3_render_frame(canceller);
  const size_t frames = std::min(mic.size() / capture_frame, ref.size() / render_frame);
  std::vector<double> micros;
  micros.reserve(frames);
  for (size_t frame = 0; frame < frames; ++frame) {
    const auto started = std::chrono::steady_clock::now();
    const int result = rn_aec3_process(canceller, mic.data() + frame * capture_frame,
                                                     ref.data() + frame * render_frame, 1);
    micros.push_back(std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - started).count());
    if (result != 0) {
      std::fprintf(stderr, "process failed at frame %zu: %d\n", frame, result);
      return 1;
    }
  }
  FILE* out = std::fopen(argv[3], "wb");
  if (!out) {
    std::fprintf(stderr, "cannot write %s\n", argv[3]);
    return 2;
  }
  const size_t written = std::fwrite(mic.data(), sizeof(float), frames * capture_frame, out);
  if (written != frames * capture_frame || std::fclose(out) != 0) {
    std::fprintf(stderr, "short write to %s\n", argv[3]);
    return 2;
  }
  RnAec3Stats stats;
  rn_aec3_stats(canceller, &stats);
  rn_aec3_destroy(canceller);
  std::sort(micros.begin(), micros.end());
  double sum = 0;
  for (double value : micros) sum += value;
  const auto reading = [](double value) { return std::isnan(value) ? std::string("null") : std::to_string(value); };
  std::printf("{\"frames\":%zu,\"meanUs\":%.1f,\"maxUs\":%.1f,\"delayMs\":%s,\"erlDb\":%s,\"erleDb\":%s}\n", frames,
              micros.empty() ? 0 : sum / micros.size(), micros.empty() ? 0 : micros.back(),
              reading(stats.delay_ms).c_str(), reading(stats.echo_return_loss_db).c_str(),
              reading(stats.echo_return_loss_enhancement_db).c_str());
  return 0;
}
