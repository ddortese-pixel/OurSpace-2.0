/**
 * index.js — OurSpace 2.0 · Zero-Redirection v2
 * ─────────────────────────────────────────────────────────────────────────────
 * CRITICAL: Everything in this file runs before React mounts.
 * This is where killed-app signal handlers MUST be registered.
 *
 * Two handlers registered here:
 *   1. FCM background/killed message handler
 *      → Receives data-only push when app is killed
 *      → Calls CallServiceV2.handleFCMDataMessage() → shows native call UI
 *
 *   2. Notifee background event handler
 *      → Handles Answer/Decline button taps on the notification
 *      → Works even when app is killed (headless JS task)
 *
 *   3. Android foreground service headless task
 *      → Keeps polling alive when app is swiped away
 */

import { AppRegistry, Platform } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

// ── 1. FCM Background + Killed-State Handler ──────────────────────────────────
// This handler fires when:
//   - App is in BACKGROUND: FCM delivers the data push
//   - App is KILLED: Android starts a headless JS task to run this
// Must be registered before AppRegistry.registerComponent()
try {
  const messaging = require('@react-native-firebase/messaging').default;

  messaging().setBackgroundMessageHandler(async (remoteMessage) => {
    const data = remoteMessage?.data || {};
    console.log('[index.js] FCM background message type=' + data.type);

    if (data.type === 'incoming_call_wake') {
      // Lazy-import CallServiceV2 to avoid circular deps at module init
      const CallServiceV2 = require('./src/services/CallServiceV2').default;
      await CallServiceV2.handleFCMDataMessage(data);
    }
  });

  // Handle notification tap when app was killed
  // This fires after the app fully mounts — but we need to store the initial
  // message so App.js can pick it up
  messaging()
    .getInitialNotification()
    .then((remoteMessage) => {
      if (remoteMessage?.data?.type === 'incoming_call_wake') {
        // Store for App.js to consume on mount
        global.__OURSPACE_INITIAL_CALL__ = remoteMessage.data;
      }
    })
    .catch(() => {});

  console.log('[index.js] FCM background handler registered ✓');
} catch (e) {
  // Firebase not installed — foreground polling is the signal path
  console.warn('[index.js] Firebase not available:', e.message);
  console.warn('[index.js] Polling fallback active — calls work when app is open');
}

// ── 2. Notifee Background Event Handler ──────────────────────────────────────
// Handles Answer / Decline button taps on the heads-up notification
// when the app is in the background or killed.
try {
  const notifee    = require('@notifee/react-native').default;
  const { EventType } = require('@notifee/react-native');

  notifee.onBackgroundEvent(async ({ type, detail }) => {
    console.log('[index.js] Notifee background event type=' + type);

    if (type !== EventType.ACTION_PRESS) return;

    const data     = detail.notification?.data || {};
    const actionId = detail.pressAction?.id    || '';
    const callId   = data.call_id;

    if (!callId) return;

    if (actionId === 'answer' || actionId.startsWith('answer_')) {
      console.log('[index.js] Answer pressed from notification callId=' + callId);
      // App will open via fullScreenAction launchActivity
      // The initial notification data is picked up by App.js on mount
      global.__OURSPACE_INITIAL_CALL__ = { ...data, _notificationAnswer: true };
    }

    if (actionId === 'decline' || actionId.startsWith('decline_')) {
      console.log('[index.js] Decline pressed from notification callId=' + callId);

      // Cancel the notification immediately
      await notifee.cancelNotification(detail.notification?.id).catch(() => {});

      // Decline the call via API (no React state needed — raw fetch)
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      const authToken    = await AsyncStorage.getItem('ourspace_auth_token').catch(() => null);

      if (authToken) {
        fetch('https://face-app-0b743c8e.base44.app/api/endCall', {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            Authorization:   `Bearer ${authToken}`,
          },
          body: JSON.stringify({ callId, reason: 'declined' }),
        }).catch(() => {});

        // Also send the signaling ACK so caller sees "declined" immediately
        fetch('https://face-app-0b743c8e.base44.app/api/signalingAck', {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            Authorization:   `Bearer ${authToken}`,
          },
          body: JSON.stringify({ callId, state: 'declined' }),
        }).catch(() => {});
      }
    }
  });

  console.log('[index.js] Notifee background handler registered ✓');
} catch (e) {
  console.warn('[index.js] Notifee not available:', e.message);
}

// ── 3. Android Foreground Service Headless Task ───────────────────────────────
// Keeps polling alive when app is swiped away from recents.
// This is the non-Firebase fallback for killed-app wake.
if (Platform.OS === 'android') {
  try {
    const { registerHeadlessTask } = require('./src/services/CallPollingForegroundService');
    registerHeadlessTask();
    console.log('[index.js] Foreground service headless task registered ✓');
  } catch (e) {
    console.warn('[index.js] Foreground service registration failed:', e.message);
  }
}

// ── 4. Register the main React app ────────────────────────────────────────────
AppRegistry.registerComponent(appName, () => App);
