/**
 * iOS outputs, by port type, whose sound does not come back to the microphone: headphones; Bluetooth, which a
 * voice session plays over the hands-free link, whose device records with its own microphone and cancels its
 * own echo (an audio session with `allowBluetoothHFP` and no A2DP never plays a Bluetooth speaker to the
 * phone's microphone); car audio, which does likewise; AirPlay, seconds behind and beyond AEC3's reach. There
 * AEC3 would only hold the near end down until it found no echo, about 6 s of far-end audio later. Every other
 * output is heard: the phone's own speaker and earpiece, speakers on a cable, and any output iOS adds later.
 */
const IOS_QUIET_OUTPUTS = new Set(["Headphones", "BluetoothHFP", "BluetoothA2DPOutput", "BluetoothLE", "CarAudio", "AirPlay"]);

/**
 * Whether the far-end audio comes back to the microphone on these iOS outputs (`AVAudioSession` port types, as
 * react-native-audio-api's `AudioManager.getDevicesInfo().currentOutputs[].category` reports them); an unknown
 * route, and an empty one, count as heard.
 */
export function iosOutputReachesMic(categories: readonly string[]): boolean {
  if (categories.length === 0) return true;
  return categories.some((category) => !IOS_QUIET_OUTPUTS.has(category));
}

/**
 * Android routes, by the module's names (`communicationRoute`), whose sound does not come back to the
 * microphone: headsets on a wire or USB, Bluetooth's call link and LE headsets, hearing aids, and a car (`bus`).
 * A2DP is not here: on the communication stream Android plays it to the speaker. Null, and an unknown name,
 * count as heard.
 */
const ANDROID_QUIET_ROUTES = new Set(["wiredHeadset", "wiredHeadphones", "usbHeadset", "bluetoothSco", "bleHeadset", "hearingAid", "bus"]);

export function androidRouteReachesMic(route: string | null): boolean {
  return route === null || !ANDROID_QUIET_ROUTES.has(route);
}
