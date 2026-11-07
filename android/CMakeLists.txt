cmake_minimum_required(VERSION 3.22.1)

project(react-native-aec3 C CXX)

# WebRTC's AEC3 (vendor/, README.md) and the module's C interface, built into one shared library with
# the JNI bridge. The same files and defines as webrtc-audio-processing 2.1's own meson build.
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)

set(MODULE_DIR "${CMAKE_CURRENT_LIST_DIR}/..")
set(WEBRTC_DIR "${MODULE_DIR}/vendor/webrtc-audio-processing/webrtc")
set(ABSL_DIR "${MODULE_DIR}/vendor/abseil-cpp")
include("${MODULE_DIR}/cpp/sources.cmake")

set(sources
  "${MODULE_DIR}/cpp/rn_aec3.cc"
  "${CMAKE_CURRENT_LIST_DIR}/src/main/cpp/jni_bridge.cc"
)
foreach(source ${WEBRTC_SOURCES} ${WEBRTC_ANDROID_SOURCES})
  list(APPEND sources "${WEBRTC_DIR}/${source}")
endforeach()
foreach(source ${ABSL_SOURCES})
  list(APPEND sources "${ABSL_DIR}/${source}")
endforeach()

set(defines WEBRTC_POSIX WEBRTC_ANDROID WEBRTC_LINUX WEBRTC_LIBRARY_IMPL WEBRTC_APM_DEBUG_DUMP=0 NDEBUG)
if(ANDROID_ABI STREQUAL "arm64-v8a" OR ANDROID_ABI STREQUAL "armeabi-v7a")
  # NEON is the baseline on both: Android's armeabi-v7a has required it since NDK r21.
  list(APPEND defines WEBRTC_HAS_NEON)
  if(ANDROID_ABI STREQUAL "arm64-v8a")
    list(APPEND defines WEBRTC_ARCH_ARM64)
  endif()
  foreach(source ${WEBRTC_NEON_SOURCES})
    list(APPEND sources "${WEBRTC_DIR}/${source}")
  endforeach()
elseif(ANDROID_ABI STREQUAL "x86_64" OR ANDROID_ABI STREQUAL "x86")
  # SSE2 kernels, and AVX2 ones compiled for AVX2 alone and chosen at run time, as meson builds them.
  list(APPEND defines WEBRTC_ENABLE_AVX2)
  foreach(source ${WEBRTC_SSE2_SOURCES})
    list(APPEND sources "${WEBRTC_DIR}/${source}")
    set_source_files_properties("${WEBRTC_DIR}/${source}" PROPERTIES COMPILE_OPTIONS "-msse2")
  endforeach()
  foreach(source ${WEBRTC_AVX2_SOURCES})
    list(APPEND sources "${WEBRTC_DIR}/${source}")
    set_source_files_properties("${WEBRTC_DIR}/${source}" PROPERTIES COMPILE_OPTIONS "-mavx2;-mfma")
  endforeach()
endif()

add_library(react-native-aec3 SHARED ${sources})
target_include_directories(react-native-aec3 PRIVATE "${WEBRTC_DIR}" "${ABSL_DIR}" "${MODULE_DIR}/cpp")
target_compile_definitions(react-native-aec3 PRIVATE ${defines})
# Optimized in debug builds too: a development client is where voice sessions are tried, and AEC3 at -O0
# costs several times its release price. Upstream's warnings are upstream's.
target_compile_options(react-native-aec3 PRIVATE -O2 -fvisibility=hidden -ffunction-sections -fdata-sections -w)
target_link_options(react-native-aec3 PRIVATE -Wl,--gc-sections -Wl,--exclude-libs,ALL)
find_library(LOG_LIB log)
target_link_libraries(react-native-aec3 ${LOG_LIB})
