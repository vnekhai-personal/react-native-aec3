require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# At the module's root rather than in ios/ (expo-module.config.json's podspecPath), because a pod may
# compile only files under its own folder, and WebRTC's sources serve Android's build as well.
webrtc = 'vendor/webrtc-audio-processing/webrtc'
abseil = 'vendor/abseil-cpp'
arm_only = %w[_neon.cc _neon.c].map { |suffix| "#{webrtc}/**/*#{suffix}" }
x86_only = %w[_sse.cc _sse2.cc _avx2.cc].map { |suffix| "#{webrtc}/**/*#{suffix}" }
android_only = ["#{webrtc}/rtc_base/system/warn_current_thread_is_deadlocked.cc"]
# File names alone, for Xcode's per-architecture exclusion.
names = ->(patterns) { patterns.flat_map { |pattern| Dir.glob(File.join(__dir__, pattern)).map { |path| File.basename(path) } }.uniq.sort.join(' ') }

Pod::Spec.new do |s|
  s.name           = 'ReactNativeAec3'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = 'webrtc-audio-processing 2.1 (BSD) and the Abseil files it links (Apache 2.0), behind a C interface; README.md.'
  s.license        = package['license']
  s.author         = 'react-native-aec3 contributors'
  s.homepage       = package['homepage']
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: package['repository']['url'] }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = [
    'ios/*.swift',
    'cpp/rn_aec3.h',
    'cpp/rn_aec3.cc',
    "#{webrtc}/**/*.{c,cc}",
    "#{abseil}/absl/**/*.cc",
  ]
  s.exclude_files = android_only
  # Swift sees the C interface only; WebRTC's and Abseil's headers stay out of the module.
  s.public_header_files = 'cpp/rn_aec3.h'
  s.preserve_paths = ['cpp/*.h', "#{webrtc}/**/*.h", "#{abseil}/**/*.{h,inc}"]
  # Abseil is on Apple's list of SDKs whose privacy manifest an app must carry; it declares nothing.
  s.resource_bundles = { 'ReactNativeAec3Privacy' => ["#{abseil}/PrivacyInfo.xcprivacy"] }

  # pffft's functions under names of our own: react-native-audio-api compiles its own pffft into the same app,
  # and of two definitions of one name the linker keeps whichever it reaches first, without a word. Android
  # hides them in the module's own library (CMakeLists.txt). __tests__/native.test.ts holds this list to
  # pffft.c's.
  pffft = %w[
    cfftf1_ps cffti1_ps pffft_aligned_free pffft_aligned_malloc pffft_cplx_finalize pffft_cplx_preprocess
    pffft_destroy_setup pffft_new_setup pffft_simd_size pffft_transform pffft_transform_internal
    pffft_transform_ordered pffft_zconvolve_accumulate pffft_zreorder validate_pffft_simd
  ].map { |name| "#{name}=rnaec3_#{name}" }.join(' ')
  defines = "WEBRTC_POSIX=1 WEBRTC_MAC=1 WEBRTC_IOS=1 WEBRTC_LIBRARY_IMPL=1 WEBRTC_APM_DEBUG_DUMP=0 NDEBUG=1 #{pffft}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    # What React Native's pod install sets on every pod whatever its podspec says, and so what compiles.
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
    'GCC_C_LANGUAGE_STANDARD' => 'c11',
    'HEADER_SEARCH_PATHS' => "\"$(PODS_TARGET_SRCROOT)/#{webrtc}\" \"$(PODS_TARGET_SRCROOT)/#{abseil}\" \"$(PODS_TARGET_SRCROOT)/cpp\"",
    'GCC_PREPROCESSOR_DEFINITIONS' => "$(inherited) #{defines}",
    'GCC_PREPROCESSOR_DEFINITIONS[arch=arm64]' => "$(inherited) #{defines} WEBRTC_ARCH_ARM64=1 WEBRTC_HAS_NEON=1",
    'GCC_PREPROCESSOR_DEFINITIONS[arch=x86_64]' => "$(inherited) #{defines} WEBRTC_ENABLE_AVX2=1",
    'EXCLUDED_SOURCE_FILE_NAMES[arch=arm64]' => names.call(x86_only),
    'EXCLUDED_SOURCE_FILE_NAMES[arch=x86_64]' => names.call(arm_only),
    # A Simulator on an Intel Mac. WebRTC compiles its AVX2 kernels alone with AVX2 and picks them at run
    # time, which a pod cannot do file by file; every Intel Mac that runs a current Xcode has AVX2.
    'OTHER_CFLAGS[arch=x86_64]' => '$(inherited) -mavx2 -mfma',
    # Optimized in debug builds too: a development client is where voice sessions are tried, and AEC3 at
    # -O0 costs several times its release price. Upstream's warnings are upstream's.
    'GCC_OPTIMIZATION_LEVEL' => '2',
    'GCC_WARN_INHIBIT_ALL_WARNINGS' => 'YES',
  }
end
