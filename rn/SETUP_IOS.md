# OurSpace 2.0 — iOS Setup Guide

Complete setup for CallKit + VoIP push on iOS.

---

## Step 1 — Info.plist background modes

Open `ios/OurSpace/Info.plist` and add:

```xml
<key>UIBackgroundModes</key>
<array>
    <string>voip</string>
    <string>audio</string>
    <string>fetch</string>
    <string>remote-notification</string>
</array>
```

---

## Step 2 — Xcode capabilities

In Xcode → Your Target → Signing & Capabilities → click **+**:

1. **Background Modes** — check:
   - ✅ Voice over IP
   - ✅ Audio, AirPlay and Picture in Picture
   - ✅ Background fetch
   - ✅ Remote notifications

2. **Push Notifications** — add this capability

---

## Step 3 — AppDelegate.m / AppDelegate.mm additions

Add CallKeep import and setup:

```objc
// AppDelegate.mm
#import <RNCallKeep/RNCallKeep.h>

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {

  // ... existing RN setup ...

  // Required for CallKit
  [RNCallKeep setup:@{
    @"appName": @"OurSpace",
    @"maximumCallGroups": @"1",
    @"maximumCallsPerCallGroup": @"1",
    @"supportsVideo": @YES,
  }];

  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

// Handle PushKit VoIP pushes (required for CallKit to work reliably)
- (void)pushRegistry:(PKPushRegistry *)registry
    didReceiveIncomingPushWithPayload:(PKPushPayload *)payload
    forType:(PKPushType)type
    withCompletionHandler:(void (^)(void))completion {

  // Route to RNCallKeep
  [RNCallKeep didReceiveStartCallAction:payload.dictionaryPayload];
  completion();
}
```

---

## Step 4 — Podfile

Your Podfile should already include CallKeep after `npm install react-native-callkeep`.
Run `pod install` to confirm:

```bash
cd ios && pod install
```

---

## Step 5 — Ringtone for iOS

Convert your ringtone MP3 to CAF format (required by iOS):

```bash
afconvert -f caff -d LEI16@44100 ringtone.mp3 ringtone.caf
```

Add `ringtone.caf` to your Xcode project:
- Drag it into `ios/OurSpace/` in Xcode
- Make sure "Copy items if needed" is checked
- Make sure it's in the app target

---

## Step 6 — APNs certificate (for killed-app wake on iOS)

iOS requires APNs to wake a killed app. Without this, the app rings only when
open or backgrounded. With it, CallKit shows the native call UI from any state.

1. Apple Developer Portal → Certificates → Create a VoIP Services Certificate
2. Download + install the certificate
3. Export as `.p12` file
4. Upload to Firebase Console → Project Settings → Cloud Messaging → iOS
5. The Firebase iOS SDK will automatically use PushKit/APNs for VoIP

---

## Step 7 — Build and run

```bash
npx react-native run-ios --device
```

(CallKit requires a real device — simulator does not support CallKit)

---

## iOS call states

| App state  | What happens |
|------------|-------------|
| Foreground | IncomingCallModal slides up + Notifee sound |
| Background | CallKit full-screen incoming call UI (requires APNs) |
| Killed     | CallKit full-screen incoming call UI (requires APNs + PushKit) |

Without APNs (no Firebase/APNs cert):
- Foreground: ✅ rings normally
- Background: ✅ rings (app backgrounded, poll continues)
- Killed: ❌ cannot wake — tell users to keep app backgrounded

---

## iOS-specific notes

- **Do Not Disturb**: CallKit calls bypass DND by default (configurable)
- **CarPlay**: CallKit calls appear in CarPlay automatically
- **Lock screen**: CallKit shows full-screen incoming call over lock screen
- **Audio session**: start WebRTC audio ONLY after `didActivateAudioSession` fires
  — NativeCallBridge already handles this via the `didActivateAudioSession` event
