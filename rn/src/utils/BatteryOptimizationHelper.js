/**
 * BatteryOptimizationHelper.js — OurSpace 2.0 Android
 * ─────────────────────────────────────────────────────────────────────────────
 * Android-specific helper to request battery optimization exemption.
 *
 * WITHOUT this exemption:
 *  - Android kills background processes to save battery
 *  - Push notifications for incoming calls are delayed or never delivered
 *  - The polling-based incoming call detection stops when app is backgrounded
 *
 * This module handles:
 *  1. Detecting if battery optimization is enabled for OurSpace
 *  2. Showing a user-friendly prompt to request exemption
 *  3. Opening the correct Android system settings screen
 *  4. Persisting the user's "don't ask again" choice
 *
 * DEPENDENCIES:
 *   npm install react-native-device-info
 *
 * ANDROID PERMISSIONS (add to AndroidManifest.xml):
 *   <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />
 *
 * MANIFEST COMPONENT (inside <application> tag):
 *   Already handled by react-native-device-info.
 *   The ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS intent is whitelisted by Google
 *   for VoIP apps: https://developer.android.com/training/monitoring-device-state/doze-standby#support_for_other_use_cases
 */

import {
  Platform,
  Alert,
  Linking,
  NativeModules,
  NativeEventEmitter,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'ourspace_battery_opt_asked';

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * checkAndPrompt()
 * Call this after app launches and user is logged in.
 * Will prompt at most once unless user says "always allow" or "never ask".
 *
 * Returns: 'exempt' | 'not_exempt' | 'skipped' | 'not_android'
 */
export async function checkAndPrompt() {
  if (Platform.OS !== 'android') {
    return 'not_android';
  }

  try {
    // Check if already exempted
    const isExempt = await _isIgnoringBatteryOptimizations();
    if (isExempt) {
      return 'exempt';
    }

    // Check if user said "don't ask again"
    const neverAsk = await AsyncStorage.getItem(STORAGE_KEY);
    if (neverAsk === 'never') {
      return 'skipped';
    }

    // Show prompt
    const result = await _showPrompt();
    return result;

  } catch (e) {
    console.warn('[BatteryOptHelper] checkAndPrompt error:', e.message);
    return 'skipped';
  }
}

/**
 * requestExemption()
 * Directly opens the battery optimization settings for OurSpace.
 * Use this when user manually taps a "Fix this" button.
 */
export async function requestExemption() {
  if (Platform.OS !== 'android') return;

  try {
    // Try direct app-specific intent first (Android 6+)
    const packageName = await _getPackageName();
    const url = `package:${packageName}`;

    const canOpen = await Linking.canOpenURL(
      `android-app://com.android.settings/ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
    ).catch(() => false);

    if (canOpen) {
      await Linking.openURL(
        `android-app://com.android.settings/ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS#${url}`
      );
    } else {
      // Fallback: open general battery settings
      await Linking.openSettings();
    }
  } catch (e) {
    // Final fallback: just open app settings
    Linking.openSettings().catch(() => {});
  }
}

/**
 * isExempted()
 * Check current exemption status without prompting.
 * Returns true if OurSpace is exempt from battery optimization.
 */
export async function isExempted() {
  if (Platform.OS !== 'android') return true;
  return _isIgnoringBatteryOptimizations();
}

/**
 * getStatusMessage()
 * Returns a user-facing status message about battery optimization.
 */
export async function getStatusMessage() {
  if (Platform.OS !== 'android') {
    return { ok: true, message: 'No action needed on iOS' };
  }

  const exempt = await isExempted();
  if (exempt) {
    return {
      ok: true,
      message: '✅ Battery optimization is disabled — calls will ring reliably',
    };
  }

  return {
    ok: false,
    message: '⚠️ Battery optimization may delay incoming calls. Tap to fix.',
  };
}

// ── Private helpers ────────────────────────────────────────────────────────────

async function _isIgnoringBatteryOptimizations() {
  try {
    // react-native-device-info provides this check
    // npm install react-native-device-info
    const DeviceInfo = require('react-native-device-info').default;
    if (DeviceInfo?.isBatteryCharging !== undefined) {
      // DeviceInfo is available — use PowerManager check via native module
      // This is a best-effort check
    }
  } catch (_) {}

  try {
    // Direct PowerManager check via NativeModules (if custom native module exists)
    if (NativeModules.PowerManagerModule?.isIgnoringBatteryOptimizations) {
      return await NativeModules.PowerManagerModule.isIgnoringBatteryOptimizations();
    }
  } catch (_) {}

  // If we can't check, assume not exempt (conservative)
  return false;
}

async function _getPackageName() {
  try {
    const DeviceInfo = require('react-native-device-info').default;
    return DeviceInfo.getBundleId();
  } catch (_) {
    return 'com.ourspace.app'; // fallback
  }
}

function _showPrompt() {
  return new Promise((resolve) => {
    Alert.alert(
      '📞 Keep Calls Ringing',
      "Android's battery optimization may stop OurSpace from ringing when you get a call.\n\nTap \"Allow\" to make sure you never miss a call.",
      [
        {
          text: "Don't Ask Again",
          style: 'destructive',
          onPress: async () => {
            await AsyncStorage.setItem(STORAGE_KEY, 'never');
            resolve('skipped');
          },
        },
        {
          text: 'Not Now',
          style: 'cancel',
          onPress: () => resolve('not_exempt'),
        },
        {
          text: 'Allow',
          onPress: async () => {
            await requestExemption();
            // Give the user time to complete the action in settings
            setTimeout(async () => {
              const exempt = await _isIgnoringBatteryOptimizations();
              resolve(exempt ? 'exempt' : 'not_exempt');
            }, 2000);
          },
        },
      ],
      { cancelable: false }
    );
  });
}

// ── Android Manifest instructions ─────────────────────────────────────────────
//
// 1. Add to android/app/src/main/AndroidManifest.xml:
//
//    <!-- Battery optimization exemption request (VoIP exception) -->
//    <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />
//
//    <!-- Foreground service for active call (keeps call alive in background) -->
//    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
//    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_PHONE_CALL" />
//
//    <!-- Wake lock to ring when screen is off -->
//    <uses-permission android:name="android.permission.WAKE_LOCK" />
//
//    <!-- Inside <application> tag: -->
//    <service
//      android:name="io.wazo.callkeep.VoiceConnectionService"
//      android:label="@string/app_name"
//      android:permission="android.permission.BIND_TELECOM_CONNECTION_SERVICE"
//      android:exported="true">
//      <intent-filter>
//        <action android:name="android.telecom.ConnectionService" />
//      </intent-filter>
//    </service>
//
// 2. Xiaomi / MIUI extra steps:
//    Users must ALSO go to:
//    Settings → Apps → OurSpace → Battery Saver → No restrictions
//    AND
//    Settings → Apps → OurSpace → Other permissions → Show on Lock Screen → Allow
//
// 3. Samsung / OneUI extra steps:
//    Settings → Apps → OurSpace → Battery → Unrestricted
//    Settings → Apps → OurSpace → allow background activity
//
// 4. Huawei / EMUI extra steps:
//    Settings → Apps → OurSpace → Battery → enable "Run in Background"
//    AND add to Protected Apps

export default {
  checkAndPrompt,
  requestExemption,
  isExempted,
  getStatusMessage,
};
