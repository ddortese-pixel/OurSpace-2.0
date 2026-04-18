# OurSpace 2.0 — Android Setup (No Firebase)

Complete setup to make calls ring from ANY app state including killed.

---

## Step 1 — Install packages

```bash
npm install @notifee/react-native
npm install @react-native-async-storage/async-storage
npm install @react-native-community/netinfo
npm install @daily-co/daily-js
```

---

## Step 2 — AndroidManifest.xml

Open `android/app/src/main/AndroidManifest.xml`

### 2a. Add permissions (inside `<manifest>` tag):

```xml
<!-- Calling -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.CAMERA" />

<!-- Notifications + wake screen -->
<uses-permission android:name="android.permission.VIBRATE" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.USE_FULL_SCREEN_INTENT" />

<!-- Foreground Service (keeps polling alive when app is killed) -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_PHONE_CALL" />

<!-- Battery optimization exemption -->
<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />

<!-- Required to restart foreground service after device reboot -->
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
```

### 2b. Add service declaration (inside `<application>` tag):

```xml
<!-- Notifee foreground service -->
<service
    android:name="app.notifee.core.ForegroundService"
    android:foregroundServiceType="phoneCall"
    android:exported="false" />
```

### Full example of what your `<application>` block should include:

```xml
<application
    android:name=".MainApplication"
    android:label="@string/app_name"
    android:icon="@mipmap/ic_launcher"
    android:allowBackup="false"
    android:theme="@style/AppTheme">

    <activity ... />

    <!-- ADD THIS -->
    <service
        android:name="app.notifee.core.ForegroundService"
        android:foregroundServiceType="phoneCall"
        android:exported="false" />

</application>
```

---

## Step 3 — Add ringtone

Create this directory if it doesn't exist:
```
android/app/src/main/res/raw/
```

Add any MP3 file named **exactly** `ringtone.mp3` to that folder.

Free ringtones: https://notificationsounds.com/ringtones

Without this file, Notifee will use the default notification sound
(still audible, just not a proper ringtone).

---

## Step 4 — Add notification icon (optional but recommended)

Add a small white icon PNG (24×24dp) named `ic_notification.png` to:
```
android/app/src/main/res/drawable/ic_notification.png
```

Without it, Android uses the default app icon (still works).

---

## Step 5 — Register the headless task in index.js

Your `rn/index.js` already has this — just verify it looks like:

```js
import { AppRegistry, Platform } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

// MUST be before registerComponent
if (Platform.OS === 'android') {
  const { registerHeadlessTask } = require('./src/services/CallPollingForegroundService');
  registerHeadlessTask();
}

AppRegistry.registerComponent(appName, () => App);
```

---

## Step 6 — Build and run

```bash
npx react-native run-android
```

---

## How to test killed-app ringing

1. Build + install the app on your Android device
2. Open the app and log in (so the auth token is stored)
3. **Swipe the app away** from recents (kill it)
4. Wait 5 seconds
5. From another device/browser, initiate a call to your email
6. Your phone should ring within 2 seconds with:
   - Full-screen call notification (shows over lock screen)
   - Ringtone playing
   - Answer + Decline buttons
   - Vibration pattern

---

## Troubleshooting killed-app ringing

### Phone doesn't ring when killed

**Check 1: Foreground Service notification visible?**
After running the app, pull down the notification shade.
You should see "📞 OurSpace — Ready to receive calls" (a persistent notification).
If missing → service didn't start → check logs for errors.

**Check 2: Battery optimization**
The app will show a yellow warning banner. Tap it and allow battery optimization
to be disabled for OurSpace.

**Check 3: OEM-specific settings**

Samsung:
- Settings → Apps → OurSpace → Battery → **Unrestricted**
- Settings → Apps → OurSpace → ✅ Allow background activity

Xiaomi/MIUI:
- Settings → Apps → Manage Apps → OurSpace → Battery Saver → **No restrictions**
- Settings → Apps → OurSpace → Other permissions → ✅ Show on Lock Screen

Huawei/EMUI:
- Settings → Apps → OurSpace → Battery → ✅ Run in Background
- Phone Manager → Protected Apps → ✅ OurSpace

OnePlus/OxygenOS:
- Settings → Battery → Battery Optimization → OurSpace → **Don't optimize**

---

## iOS note

iOS cannot ring from a killed state without APNs (Apple Push Notification Service).

Options for iOS:
1. **Tell users to keep the app backgrounded** (not killed) — the foreground
   service equivalent on iOS is Background App Refresh, which is unreliable.
2. **Use CallKit + PushKit** — this is the proper iOS solution but requires
   an Apple Developer account and APNs certificate setup.

For now, on iOS, the app rings reliably when in foreground or background.
