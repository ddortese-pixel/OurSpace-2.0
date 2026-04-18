/**
 * NativeCallBridge.js — OurSpace 2.0 · Zero-Redirection v2
 * ─────────────────────────────────────────────────────────────────────────────
 * Bridges React Native to Android ConnectionService and iOS CallKit.
 *
 * This is the "Native Integration" layer the master prompt requires:
 *   "Use Android ConnectionService and iOS CallKit (via a native bridge)
 *    so calls appear as native system events, even when the phone is locked."
 *
 * ANDROID (ConnectionService):
 *   - Uses react-native-callkeep which wraps Android ConnectionService
 *   - Calls appear in the native phone app UI (lock screen, heads-up, dialer)
 *   - Works even when the app is killed
 *
 * iOS (CallKit):
 *   - Same react-native-callkeep package wraps CallKit
 *   - Calls appear as a full-screen native incoming call UI
 *   - Integrates with Do Not Disturb and CarPlay
 *
 * INSTALL:
 *   npm install react-native-callkeep
 *   (iOS) cd ios && pod install
 *
 *   Android: add to AndroidManifest.xml:
 *     <uses-permission android:name="android.permission.READ_PHONE_STATE" />
 *     <uses-permission android:name="android.permission.CALL_PHONE" />
 *     <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
 *
 * USAGE:
 *   import NativeCallBridge from './NativeCallBridge';
 *   await NativeCallBridge.init(onAnswer, onDecline);
 *   NativeCallBridge.showIncomingCall(callData);
 *   NativeCallBridge.endCall(callId);
 */

import { Platform } from 'react-native';

// ── Lazy load react-native-callkeep (fail-safe) ───────────────────────────────
let RNCallKeep = null;

function _loadCallKeep() {
  if (RNCallKeep) return true;
  try {
    const mod = require('react-native-callkeep');
    RNCallKeep = mod.default || mod.RNCallKeep;
    return !!RNCallKeep;
  } catch (e) {
    console.warn('[NativeCallBridge] react-native-callkeep not installed:', e.message);
    console.warn('[NativeCallBridge] Run: npm install react-native-callkeep');
    return false;
  }
}

// ── Configuration ─────────────────────────────────────────────────────────────
const CALLKEEP_CONFIG = {
  ios: {
    appName:                    'OurSpace',
    supportsVideo:              true,
    maximumCallGroups:          '1',
    maximumCallsPerCallGroup:   '1',
    imageName:                  'ourspace_icon',      // native asset in Assets.xcassets
    ringtoneSound:              'ringtone.caf',
  },
  android: {
    alertTitle:                 'Permissions required',
    alertDescription:           'Allow OurSpace to make and manage calls',
    cancelButton:               'Cancel',
    okButton:                   'Allow',
    imageName:                  'ourspace_icon',
    additionalPermissions:      [],
    // ConnectionService: calls go through Android's native telephony stack
    selfManaged:                true,                 // false = integrates with native dialer
    foregroundService: {
      channelId:                'ourspace_incoming_call',
      channelName:              'Incoming Calls',
      notificationTitle:        'OurSpace is waiting for a call',
      notificationIcon:         'ic_launcher',
    },
  },
};

// ── Internal state ─────────────────────────────────────────────────────────────
let _initialized   = false;
let _onAnswerCb    = null;
let _onDeclineCb   = null;
let _onEndCb       = null;
let _activeCalls   = new Map(); // callId → callData

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * init(onAnswer, onDecline, onEnd)
 * Must be called once at app startup (before any calls).
 */
async function init(onAnswer, onDecline, onEnd) {
  _onAnswerCb  = onAnswer;
  _onDeclineCb = onDecline;
  _onEndCb     = onEnd;

  if (!_loadCallKeep()) {
    console.warn('[NativeCallBridge] Running without native call UI (CallKeep not installed)');
    return false;
  }

  try {
    await RNCallKeep.setup(CALLKEEP_CONFIG);
    _wireEvents();
    _initialized = true;
    console.log('[NativeCallBridge] Initialized ✓ platform=' + Platform.OS);
    return true;
  } catch (e) {
    console.error('[NativeCallBridge] Setup failed:', e.message);
    return false;
  }
}

/**
 * showIncomingCall(callData)
 * Shows the native system call UI (lock screen + heads-up).
 * On Android: ConnectionService incoming call sheet
 * On iOS: CallKit full-screen incoming call UI
 */
function showIncomingCall(callData) {
  const { call_id, sender_name, sender_email, call_type } = callData;

  if (!call_id) {
    console.warn('[NativeCallBridge] showIncomingCall: missing call_id');
    return;
  }

  _activeCalls.set(call_id, callData);

  if (!RNCallKeep || !_initialized) {
    console.warn('[NativeCallBridge] CallKeep not ready — skipping native UI');
    return;
  }

  try {
    RNCallKeep.displayIncomingCall(
      call_id,                                           // uuid
      sender_email || 'unknown',                         // handle (shown as number/address)
      sender_name  || 'Unknown',                         // localizedCallerName
      'email',                                           // handleType: 'number' | 'email' | 'generic'
      call_type === 'video',                             // hasVideo
    );
    console.log('[NativeCallBridge] Native incoming call displayed callId=' + call_id);
  } catch (e) {
    console.error('[NativeCallBridge] displayIncomingCall error:', e.message);
  }
}

/**
 * reportCallConnected(callId)
 * Tell the OS the call is now connected (switches from ringing to active call UI).
 */
function reportCallConnected(callId) {
  if (!RNCallKeep || !_initialized) return;
  try {
    RNCallKeep.setCurrentCallActive(callId);
    console.log('[NativeCallBridge] Call marked active callId=' + callId);
  } catch (e) {
    console.warn('[NativeCallBridge] setCurrentCallActive error:', e.message);
  }
}

/**
 * endCall(callId)
 * Dismiss the native call UI (call ended or declined).
 */
function endCall(callId) {
  _activeCalls.delete(callId);

  if (!RNCallKeep || !_initialized) return;
  try {
    RNCallKeep.endCall(callId);
    console.log('[NativeCallBridge] Native call ended callId=' + callId);
  } catch (e) {
    console.warn('[NativeCallBridge] endCall error:', e.message);
  }
}

/**
 * startOutgoingCall(callId, recipientName, recipientHandle, isVideo)
 * Registers an outgoing call with the OS (shows in recents, connects to Bluetooth, etc.)
 */
function startOutgoingCall(callId, recipientName, recipientHandle, isVideo = false) {
  if (!RNCallKeep || !_initialized) return;
  try {
    RNCallKeep.startCall(callId, recipientHandle, recipientName, 'email', isVideo);
    console.log('[NativeCallBridge] Outgoing call registered callId=' + callId);
  } catch (e) {
    console.warn('[NativeCallBridge] startCall error:', e.message);
  }
}

/**
 * setMuted(callId, muted)
 * Sync mute state with the native call UI.
 */
function setMuted(callId, muted) {
  if (!RNCallKeep || !_initialized) return;
  try { RNCallKeep.setMutedCall(callId, muted); } catch (_) {}
}

/**
 * setSpeaker(callId, on)
 * Toggle speakerphone via native API.
 */
function setSpeaker(callId, on) {
  if (!RNCallKeep || !_initialized) return;
  try { RNCallKeep.toggleAudioRouteSpeaker(callId, on); } catch (_) {}
}

/**
 * isAvailable()
 * Returns true if native call UI is properly initialized.
 */
function isAvailable() {
  return _initialized && !!RNCallKeep;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE — Event wiring
// ─────────────────────────────────────────────────────────────────────────────

function _wireEvents() {
  if (!RNCallKeep) return;

  // User tapped "Answer" on the native incoming call UI
  RNCallKeep.addEventListener('answerCall', ({ callUUID }) => {
    console.log('[NativeCallBridge] answerCall event callId=' + callUUID);
    const callData = _activeCalls.get(callUUID);
    if (callData) {
      _onAnswerCb?.(callData);
    } else {
      // CallData not in memory (killed app woke up) — emit with just ID
      _onAnswerCb?.({ call_id: callUUID });
    }
  });

  // User tapped "Decline" / "End" on the native incoming call UI
  RNCallKeep.addEventListener('endCall', ({ callUUID }) => {
    console.log('[NativeCallBridge] endCall event callId=' + callUUID);
    _activeCalls.delete(callUUID);
    _onDeclineCb?.(callUUID);
  });

  // CallKit/ConnectionService performed the end (e.g. Do Not Disturb, timeout)
  RNCallKeep.addEventListener('didPerformEndCallAction', ({ callUUID }) => {
    console.log('[NativeCallBridge] didPerformEndCallAction callId=' + callUUID);
    _activeCalls.delete(callUUID);
    _onEndCb?.(callUUID);
  });

  // Audio route changed (Bluetooth headset connected, etc.)
  RNCallKeep.addEventListener('didChangeAudioRoute', (event) => {
    console.log('[NativeCallBridge] Audio route changed:', event?.output);
  });

  // CallKit activated audio session (iOS — start WebRTC audio HERE, not before)
  RNCallKeep.addEventListener('didActivateAudioSession', () => {
    console.log('[NativeCallBridge] Audio session activated (iOS CallKit)');
  });

  // Mute toggled from native UI
  RNCallKeep.addEventListener('didPerformSetMutedCallAction', ({ muted, callUUID }) => {
    console.log('[NativeCallBridge] Mute toggled:', muted, 'callId=' + callUUID);
    // Forward to WebRTCConnectionService if needed
  });

  // DTMF pressed (if applicable)
  RNCallKeep.addEventListener('didReceiveStartCallAction', ({ handle, callUUID }) => {
    console.log('[NativeCallBridge] Start call action callId=' + callUUID, 'handle=' + handle);
  });
}

// ─────────────────────────────────────────────────────────────────────────────

const NativeCallBridge = {
  init,
  showIncomingCall,
  reportCallConnected,
  endCall,
  startOutgoingCall,
  setMuted,
  setSpeaker,
  isAvailable,
};

export default NativeCallBridge;
