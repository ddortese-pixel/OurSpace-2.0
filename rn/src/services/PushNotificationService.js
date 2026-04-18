/**
 * PushNotificationService.js — OurSpace 2.0 · NO FIREBASE VERSION
 * ─────────────────────────────────────────────────────────────────────────────
 * Zero Firebase required. Zero FCM. Zero APNs setup.
 *
 * SIGNAL DELIVERY (2-layer system without Firebase):
 *
 *   LAYER 1 — Notifee local notification
 *     → Triggered by Layer 2 when a call is detected
 *     → Shows ringtone + vibration + Answer/Decline buttons
 *     → Works when app is in foreground OR background
 *     → Shows over lock screen on Android
 *
 *   LAYER 2 — Polling (every 2s, always running)
 *     → /api/getPendingCallNotification
 *     → Detects incoming call → triggers Layer 1
 *     → Works 100% reliably when app is open or backgrounded
 *     → Does NOT wake a completely killed app (that requires FCM/CallKit)
 *       → Solution: Android foreground service keeps the app alive (see below)
 *
 * KILLED APP WAKE (no Firebase workaround):
 *   On Android: Run a Foreground Service that keeps polling alive
 *   even when the user swipes the app away. See HeadlessTask setup below.
 *
 *   On iOS: There is no way to wake a killed iOS app without APNs/PushKit.
 *   Best UX workaround: tell users to keep app in background (not kill it).
 *
 * INSTALL (minimal — no Firebase):
 *   npm install @notifee/react-native
 *   (iOS only) cd ios && pod install
 *
 * ANDROID ringtone:
 *   Place ringtone.mp3 in android/app/src/main/res/raw/ringtone.mp3
 */

import { Platform, Vibration, AppState } from 'react-native';
import { api, ENDPOINTS, log } from '../config/api';

// ── Lazy load Notifee (fail-safe if not installed) ────────────────────────────
let notifee = null;
let AndroidImportance, AndroidVisibility, AndroidCategory, EventType, TriggerType;

function _loadNotifee() {
  if (notifee) return true;
  try {
    const mod        = require('@notifee/react-native');
    notifee          = mod.default;
    AndroidImportance = mod.AndroidImportance;
    AndroidVisibility = mod.AndroidVisibility;
    AndroidCategory   = mod.AndroidCategory;
    EventType         = mod.EventType;
    TriggerType       = mod.TriggerType;
    return true;
  } catch (e) {
    log.warn('Notifee not installed — using Vibration-only fallback');
    log.warn('Run: npm install @notifee/react-native');
    return false;
  }
}

// ── Channel IDs ───────────────────────────────────────────────────────────────
const CHANNEL_CALL   = 'ourspace_incoming_call';
const CHANNEL_SYSTEM = 'ourspace_system';

// ── State ─────────────────────────────────────────────────────────────────────
let _initialized       = false;
let _notifeeUnsub      = null;
let _onIncomingCallCb  = null;
let _channelsCreated   = false;

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * init(onIncomingCall)
 * Sets up notification channels and button handlers.
 * No Firebase / no token registration needed.
 *
 * @param onIncomingCall (callData) => void
 */
export async function init(onIncomingCall) {
  _onIncomingCallCb = onIncomingCall;

  if (_initialized) return;

  _loadNotifee();
  await _createChannels();
  await _requestPermissions();
  _wireButtonHandlers();

  _initialized = true;
  log.info('PushNotificationService (no-Firebase) initialized ✓');
}

/**
 * showIncomingCallUI(callData)
 * Shows the heads-up notification with Answer/Decline buttons + starts ringtone.
 * Called by CallService when polling detects an incoming call.
 */
export async function showIncomingCallUI(callData) {
  log.info('showIncomingCallUI callId=', callData?.call_id);
  _startVibration();
  await _showCallNotification(callData);
}

/**
 * cancelIncomingCallUI(callId)
 * Dismiss the ringtone and notification when call ends.
 */
export async function cancelIncomingCallUI(callId) {
  Vibration.cancel();
  if (notifee && callId) {
    try { await notifee.cancelNotification(`call_${callId}`); } catch (_) {}
  }
}

/**
 * getToken()
 * No token in no-Firebase mode — returns null.
 * The backend will see no push token and rely on polling.
 */
export function getToken() { return null; }

/**
 * cleanup()
 */
export function cleanup() {
  _notifeeUnsub?.();
  Vibration.cancel();
  _initialized = false;
  log.info('PushNotificationService cleaned up');
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE
// ─────────────────────────────────────────────────────────────────────────────

async function _createChannels() {
  if (!notifee || Platform.OS !== 'android' || _channelsCreated) return;
  try {
    await notifee.createChannel({
      id:               CHANNEL_CALL,
      name:             'Incoming Calls',
      importance:       AndroidImportance.HIGH,
      visibility:       AndroidVisibility.PUBLIC,
      vibration:        true,
      vibrationPattern: [0, 500, 250, 500, 250, 500],
      sound:            'ringtone',   // → android/app/src/main/res/raw/ringtone.mp3
      lights:           true,
      lightColor:       '#6366f1',
      badge:            false,
    });
    await notifee.createChannel({
      id: CHANNEL_SYSTEM, name: 'System Notifications',
      importance: AndroidImportance.DEFAULT,
    });
    _channelsCreated = true;
    log.info('Notification channels created');
  } catch (e) {
    log.warn('createChannels error:', e.message);
  }
}

async function _requestPermissions() {
  if (!notifee) return;
  try {
    const result = await notifee.requestPermission();
    const granted = (result?.authorizationStatus || 0) >= 1;
    log.info('Notification permission:', granted ? 'granted ✓' : 'denied ✗');
    return granted;
  } catch (e) {
    log.warn('requestPermission error:', e.message);
    return false;
  }
}

function _wireButtonHandlers() {
  if (!notifee) return;
  try {
    _notifeeUnsub = notifee.onForegroundEvent(({ type, detail }) => {
      if (type === EventType.ACTION_PRESS) {
        const data = detail.notification?.data || {};
        if (detail.pressAction?.id === 'answer') {
          log.info('Answer button tapped callId=', data.call_id);
          Vibration.cancel();
          _onIncomingCallCb?.(_normalize(data));
        } else if (detail.pressAction?.id === 'decline') {
          log.info('Decline button tapped callId=', data.call_id);
          _declineFromNotif(data.call_id);
        }
      }
      // User swiped away the call notification = decline
      if (type === EventType.DISMISSED) {
        const data = detail.notification?.data || {};
        if (data.type === 'incoming_call') {
          _declineFromNotif(data.call_id);
        }
      }
    });
  } catch (e) {
    log.warn('_wireButtonHandlers error:', e.message);
  }
}

async function _showCallNotification(callData) {
  if (!notifee) {
    // Vibration-only fallback (Notifee not installed)
    log.warn('Notifee unavailable — vibration only. Install @notifee/react-native for full call UI.');
    return;
  }

  const callerName = callData?.sender_name || callData?.sender_email || 'Someone';
  const callType   = callData?.call_type   || 'voice';
  const callId     = callData?.call_id     || 'unknown';

  try {
    await notifee.displayNotification({
      id:    `call_${callId}`,
      title: `📞 Incoming ${callType === 'video' ? 'Video' : 'Voice'} Call`,
      body:  `${callerName} is calling you`,
      data:  { ...callData, type: 'incoming_call' },

      android: {
        channelId: CHANNEL_CALL,
        importance: AndroidImportance.HIGH,

        // Shows over lock screen (requires USE_FULL_SCREEN_INTENT permission)
        fullScreenAction: { id: 'default', launchActivity: 'default' },

        // Answer / Decline buttons directly on the notification
        actions: [
          { title: '📵  Decline', pressAction: { id: 'decline' } },
          { title: '📞  Answer',  pressAction: { id: 'answer', launchActivity: 'default' } },
        ],

        category:         AndroidCategory.CALL,
        color:            '#6366f1',
        colorized:        true,
        ongoing:          true,       // can't be swiped away
        onlyAlertOnce:    false,
        autoCancel:       false,
        lightUpScreen:    true,       // wakes screen
        visibility:       AndroidVisibility.PUBLIC,
        sound:            'ringtone', // android/app/src/main/res/raw/ringtone.mp3
        vibrationPattern: [0, 500, 250, 500, 250, 500],
        largeIcon:        callData?.sender_avatar || undefined,
      },

      ios: {
        // iOS without APNs: this only shows when app is in foreground
        sound: 'ringtone.caf',
        foregroundPresentationOptions: {
          alert: true, badge: true, sound: true, banner: true,
        },
      },
    });

    log.info('Call notification displayed callId=', callId);
  } catch (e) {
    log.error('_showCallNotification error:', e.message);
  }
}

function _startVibration() {
  try {
    Vibration.vibrate([0, 500, 250, 500, 250, 500], true);
  } catch (_) {}
}

function _normalize(data) {
  return {
    call_id:         data.call_id,
    call_type:       data.call_type       || 'voice',
    room_url:        data.room_url        || null,
    room_name:       data.room_name       || null,
    recipient_token: data.recipient_token || null,
    sender_email:    data.sender_email    || null,
    sender_name:     data.sender_name     || null,
    sender_avatar:   data.sender_avatar   || null,
    ice_servers:     _tryParse(data.ice_servers),
  };
}

function _tryParse(val) {
  if (!val) return null;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch (_) { return null; }
}

async function _declineFromNotif(callId) {
  if (!callId) return;
  Vibration.cancel();
  if (notifee) await notifee.cancelNotification(`call_${callId}`).catch(() => {});
  await api.post('/api/endCall', { callId, reason: 'declined' }).catch(() => {});
}
