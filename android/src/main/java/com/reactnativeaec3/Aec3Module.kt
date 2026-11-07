package com.reactnativeaec3

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.sharedobjects.SharedObject
import expo.modules.kotlin.jni.ArrayBuffer
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executor

class EchoCancellerException(message: String) : CodedException(message)

/**
 * WebRTC's AEC3 for a microphone (README.md): one canceller per session, made and fed from JavaScript.
 * Also where Android plays now, which react-native-audio-api does not report there: JavaScript runs AEC3 only
 * on a route whose sound comes back to the microphone (`androidRouteReachesMic` in src/routes.ts).
 */
class Aec3Module : Module() {
  /** What `watchRoutes` registered, with the context and manager it registered them on, to undo once the app's context is gone. */
  private class RouteWatch(
    val context: Context,
    val manager: AudioManager,
    val deviceCallback: AudioDeviceCallback,
    val communicationListener: Any?,
    val scoReceiver: BroadcastReceiver?,
  )

  private var routeWatch: RouteWatch? = null

  private val audioManager: AudioManager?
    get() = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

  override fun definition() = ModuleDefinition {
    Name("Aec3")

    Events("onRouteChange")

    // A voice session's output follows Android's communication device.
    Function("communicationRoute") { -> communicationRoute() }

    OnStartObserving("onRouteChange") { watchRoutes() }

    OnStopObserving("onRouteChange") { stopWatchingRoutes() }

    OnDestroy { stopWatchingRoutes() }

    Class(EchoCanceller::class) {
      // Doubles, as JavaScript numbers are, checked before any conversion to Int (and again in C).
      Constructor { captureRate: Double, renderRate: Double, maxFrames: Double ->
        val capture = EchoCanceller.rate(captureRate)
        val render = EchoCanceller.rate(renderRate)
        if (capture == null || render == null) throw EchoCancellerException("$captureRate Hz and $renderRate Hz are not rates AEC3 runs at")
        val frames = EchoCanceller.exactOrNull(maxFrames)
        if (frames == null || frames <= 0 || frames > EchoCanceller.MAX_FRAMES_LIMIT) {
          throw EchoCancellerException("$maxFrames is not a number of frames between 1 and ${EchoCanceller.MAX_FRAMES_LIMIT}")
        }
        EchoCanceller(capture, render, frames)
      }

      // The audio lives in direct buffers the canceller owns and shares with JavaScript as ArrayBuffers over the
      // same memory: JavaScript copies each chunk in, calls `process` with a frame count, and copies the result
      // out. Native code never takes a pointer, a length or an offset from JavaScript (CLAUDE.md, "Rules this code keeps").
      Function("captureBuffer") { canceller: EchoCanceller -> canceller.captureArrayBuffer }
      Function("renderBuffer") { canceller: EchoCanceller -> canceller.renderArrayBuffer }

      // Synchronous on purpose, on the JavaScript thread as the microphone's audio arrives there: JavaScript
      // waits for it, so nothing reads or writes the shared buffers meanwhile. Never an AsyncFunction.
      Function("process") { canceller: EchoCanceller, frames: Double ->
        canceller.process(EchoCanceller.exact(frames, "frame count"))
      }

      Function("readings") { canceller: EchoCanceller -> canceller.readings() }
    }
  }

  /** The communication device's route name; null once the app's context is gone. */
  private fun communicationRoute(): String? {
    val manager = audioManager ?: return null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      return manager.communicationDevice?.let { routeName(it.type) }
    }
    // Before Android 12 there is no communication device to ask: Bluetooth's call link if it is up, else a
    // headset plugged in, else the speaker or the earpiece.
    @Suppress("DEPRECATION")
    if (manager.isBluetoothScoOn) return "bluetoothSco"
    manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull { it.type in PLUGGED_HEADSETS }?.let {
      return routeName(it.type)
    }
    @Suppress("DEPRECATION")
    return if (manager.isSpeakerphoneOn) "builtinSpeaker" else "builtinEarpiece"
  }

  /**
   * Tells JavaScript the route whenever a device comes or goes, or the communication device moves; before
   * Android 12, whenever Bluetooth's call link comes or goes, which adds or removes no device. Nothing reports a
   * move between the speaker and the earpiece there.
   */
  @Synchronized
  private fun watchRoutes() {
    stopWatchingRoutes()
    val context = appContext.reactContext ?: return
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    val deviceCallback = object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) = notifyRoute()

      override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) = notifyRoute()
    }
    manager.registerAudioDeviceCallback(deviceCallback, null)
    var communicationListener: Any? = null
    var scoReceiver: BroadcastReceiver? = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val listener = AudioManager.OnCommunicationDeviceChangedListener { notifyRoute() }
      manager.addOnCommunicationDeviceChangedListener(Executor { it.run() }, listener)
      communicationListener = listener
    } else {
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) = notifyRoute()
      }
      context.registerReceiver(receiver, IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED))
      scoReceiver = receiver
    }
    routeWatch = RouteWatch(context, manager, deviceCallback, communicationListener, scoReceiver)
  }

  @Synchronized
  private fun stopWatchingRoutes() {
    val watch = routeWatch ?: return
    routeWatch = null
    watch.manager.unregisterAudioDeviceCallback(watch.deviceCallback)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (watch.communicationListener as? AudioManager.OnCommunicationDeviceChangedListener)?.let {
        watch.manager.removeOnCommunicationDeviceChangedListener(it)
      }
    }
    watch.scoReceiver?.let { receiver -> runCatching { watch.context.unregisterReceiver(receiver) } }
  }

  private fun notifyRoute() {
    // On the main thread or one of the audio service's, where a throw would end the app: a change that lands
    // as the module goes away has no one left to tell.
    runCatching { sendEvent("onRouteChange", mapOf("route" to communicationRoute())) }
  }

  private companion object {
    val PLUGGED_HEADSETS = setOf(
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_USB_HEADSET,
    )
  }
}

/** The names JavaScript knows routes by, one for each kind of device a voice session can play on. */
internal fun routeName(type: Int): String =
  when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "builtinEarpiece"
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "builtinSpeaker"
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE -> "builtinSpeakerSafe"
    AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wiredHeadset"
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wiredHeadphones"
    AudioDeviceInfo.TYPE_USB_HEADSET -> "usbHeadset"
    AudioDeviceInfo.TYPE_USB_DEVICE -> "usbDevice"
    AudioDeviceInfo.TYPE_USB_ACCESSORY -> "usbAccessory"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetoothSco"
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetoothA2dp"
    AudioDeviceInfo.TYPE_BLE_HEADSET -> "bleHeadset"
    AudioDeviceInfo.TYPE_BLE_SPEAKER -> "bleSpeaker"
    AudioDeviceInfo.TYPE_HEARING_AID -> "hearingAid"
    AudioDeviceInfo.TYPE_LINE_ANALOG -> "lineAnalog"
    AudioDeviceInfo.TYPE_LINE_DIGITAL -> "lineDigital"
    AudioDeviceInfo.TYPE_AUX_LINE -> "auxLine"
    AudioDeviceInfo.TYPE_HDMI -> "hdmi"
    AudioDeviceInfo.TYPE_HDMI_ARC -> "hdmiArc"
    AudioDeviceInfo.TYPE_DOCK -> "dock"
    AudioDeviceInfo.TYPE_BUS -> "bus"
    else -> "other"
  }

class EchoCanceller(captureRate: Int, renderRate: Int, private val maxFrames: Int) : SharedObject() {
  private var handle: Long = nativeCreate(captureRate, renderRate)
  private val captureFrame: Int
  private val renderFrame: Int
  private val stats = DoubleArray(3)
  /** Owned here, direct, native byte order; shared with JavaScript as views over the same memory. */
  private val capture: ByteBuffer
  private val render: ByteBuffer
  val captureArrayBuffer: ArrayBuffer
  val renderArrayBuffer: ArrayBuffer

  init {
    if (handle == 0L) throw EchoCancellerException("WebRTC made no echo canceller for $captureRate Hz and $renderRate Hz")
    captureFrame = nativeCaptureFrame(handle)
    renderFrame = nativeRenderFrame(handle)
    capture = ByteBuffer.allocateDirect(maxFrames * captureFrame * 4).order(ByteOrder.nativeOrder())
    render = ByteBuffer.allocateDirect(maxFrames * renderFrame * 4).order(ByteOrder.nativeOrder())
    captureArrayBuffer = ArrayBuffer(capture)
    renderArrayBuffer = ArrayBuffer(render)
  }

  /** Cancels `frames` 10 ms frames of the capture buffer in place, each after the render buffer's 10 ms over the same span. */
  fun process(frames: Int) {
    if (handle == 0L) throw EchoCancellerException("the echo canceller was released")
    if (frames > maxFrames) throw EchoCancellerException("$frames frames do not fit the $maxFrames-frame buffers")
    if (frames == 0) return
    val result = nativeProcess(handle, capture, render, frames)
    if (result == -2) throw EchoCancellerException("a buffer is smaller than $frames frames need")
    if (result != 0) throw EchoCancellerException("WebRTC refused the audio ($result)")
  }

  /** AEC3's readings as of the last frame processed, each null before the first (rn_aec3.h). */
  fun readings(): Map<String, Double?> {
    if (handle == 0L) throw EchoCancellerException("the echo canceller was released")
    nativeStats(handle, stats)
    val reading = { value: Double -> value.takeUnless { it.isNaN() } }
    return mapOf(
      "delayMs" to reading(stats[0]),
      "echoReturnLossDb" to reading(stats[1]),
      "echoReturnLossEnhancementDb" to reading(stats[2]),
    )
  }

  override fun sharedObjectDidRelease() {
    if (handle != 0L) nativeDestroy(handle)
    handle = 0L
  }

  companion object {
    private val SUPPORTED_RATES = setOf(8_000, 16_000, 24_000, 32_000, 44_100, 48_000)
    /** 10 s of audio at most per canceller: the buffers are allocated once, for the largest chunk a caller may hand over. */
    const val MAX_FRAMES_LIMIT = 1_000

    /** The rate as Int where it is one AEC3 runs at, else null: a NaN, an infinity or an out-of-range value never reaches a conversion. */
    fun rate(value: Double): Int? = exactOrNull(value)?.takeIf { it in SUPPORTED_RATES }

    /** A whole number within Int, else null. */
    fun exactOrNull(value: Double): Int? {
      if (!value.isFinite() || value != Math.rint(value) || value < Int.MIN_VALUE || value > Int.MAX_VALUE) return null
      return value.toInt()
    }

    /** A whole non-negative number within Int, else an exception naming `what`. */
    fun exact(value: Double, what: String): Int =
      exactOrNull(value)?.takeIf { it >= 0 } ?: throw EchoCancellerException("$value is not a valid $what")

    init {
      System.loadLibrary("react-native-aec3")
    }

    @JvmStatic external fun nativeCreate(captureRate: Int, renderRate: Int): Long
    @JvmStatic external fun nativeCaptureFrame(handle: Long): Int
    @JvmStatic external fun nativeRenderFrame(handle: Long): Int
    @JvmStatic external fun nativeProcess(handle: Long, capture: ByteBuffer, render: ByteBuffer, frames: Int): Int
    @JvmStatic external fun nativeStats(handle: Long, out: DoubleArray)
    @JvmStatic external fun nativeDestroy(handle: Long)
  }
}
