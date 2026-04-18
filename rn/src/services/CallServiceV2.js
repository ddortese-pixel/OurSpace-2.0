/**
 * CallServiceV2.js — OurSpace 2.0 · Zero-Redirection v2
 * ─────────────────────────────────────────────────────────────────────────────
 * COMPLETE REWRITE — Implements the full Zero-Redirection Master Prompt spec:
 *
 * ✅ Pre-flight Handshake (server-side friendship + fresh token fetch)
 * ✅ High-Priority Data-Only FCM Wake-Up (not a notification — wakes killed apps)
 * ✅ State-Driven Signaling via SignalingState entity (not request/response)
 * ✅ Recipient ACK signal (caller knows device received the push)
 * ✅ Native Call UI via NativeCallBridge (Android ConnectionService + iOS CallKit)
 * ✅ Dynamic TURN credentials (no hardcoded servers)
 * ✅ Polling as guaranteed fallback (Layer 3)
 * ✅ Friendship-gated calls (server enforces, client can check too)
 * ✅ Auto token refresh on app open
 *
 * SIGNAL DELIVERY CHAIN:
 *   1. preflightAndInitiateCall → validates friendship + fetches fresh token
 *   2. High-priority data-only FCM push → wakes device (even killed)
 *   3. RN FCM handler (background/killed) → calls NativeCallBridge.showIncomingCall()
 *   4. NativeCallBridge → shows ConnectionService/CallKit UI on lock screen
 *   5. Polling (2s) → Layer 3 fallback if FCM fails
 *   6. User taps Answer → signalingAck(ack_received) → caller sees it
 *   7. WebRTC join → signalingAck(connected) → call is live
 *
 * IMPORT AND REPLACE CallService.js WITH THIS FILE.
 */

import { Vibration, Platform, AppState } from 'react-native';
import { api, ENDPOINTS, POLL, log } from '../config/api';
import WebRTCConnectionService from './WebRTCConnectionService';
import PushNotificationService from './PushNotificationService';
import NativeCallBridge from './NativeCallBridge';

// ── Additional endpoints ───────────────────────────────────────────────────────
const ENDPOINTS_V2 = {
  ...ENDPOINTS,
  PREFLIGHT_INITIATE:   '/api/preflightAndInitiateCall',
  SIGNALING_ACK:        '/api/signalingAck',
  REFRESH_DEVICE_TOKEN: '/api/refreshDeviceToken',
};

// ── Internal state ─────────────────────────────────────────────────────────────
let _activeCallId        = null;
let _callStartedAt       = null;
let _statusPollTimer     = null;
let _incomingPollTimer   = null;
let _ringTimeoutTimer    = null;
let _isPollingIncoming   = false;
let _seenCallIds         = new Set();
let _currentUserEmail    = null;
let _nativeBridgeReady   = false;
let _appStateSub         = null;

export let lastPollResult = { time: null, found: false, callId: null };

// ── Event bus ──────────────────────────────────────────────────────────────────
const _listeners = {};

function emit(event, payload) {
  log.debug(`emit:${event}`, payload);
  (_listeners[event] || []).forEach(fn => {
    try { fn(payload); } catch (e) { log.error(`Listener error on ${event}:`, e.message); }
  });
}

export function addListener(event, fn) {
  if (!_listeners[event]) _listeners[event] = [];
  _listeners[event].push(fn);
  return () => { _listeners[event] = (_listeners[event] || []).filter(f => f !== fn); };
}

function getDurationSeconds() {
  if (!_callStartedAt) return 0;
  return Math.max(0, Math.round((Date.now() - _callStartedAt) / 1000));
}

// ── Cleanup ────────────────────────────────────────────────────────────────────
async function _cleanupCall(callId) {
  clearInterval(_statusPollTimer);
  clearTimeout(_ringTimeoutTimer);
  _statusPollTimer  = null;
  _ringTimeoutTimer = null;
  Vibration.cancel();
  if (callId) NativeCallBridge.endCall(callId);
  await WebRTCConnectionService.leave('cleanup');
}

// ─────────────────────────────────────────────────────────────────────────────
// INITIALIZATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * initialize(userEmail)
 * Call once when the user logs in / app mounts.
 * Sets up native call UI, token refresh, and incoming poll.
 */
export async function initialize(userEmail) {
  _currentUserEmail = userEmail;

  // 1. Set up native call bridge (ConnectionService / CallKit)
  _nativeBridgeReady = await NativeCallBridge.init(
    (callData) => _handleNativeAnswer(callData),
    (callId)   => _handleNativeDecline(callId),
    (callId)   => _handleNativeEnd(callId),
  );

  log.info(`NativeCallBridge ready: ${_nativeBridgeReady}`);

  // 2. Refresh device token on mount
  await _refreshToken();

  // 3. Set up app state listener to refresh token whenever app comes to foreground
  _appStateSub = AppState.addEventListener('change', async (nextState) => {
    if (nextState === 'active') {
      await _refreshToken();
    }
  });

  // 4. Start incoming call polling
  startIncomingPoll(userEmail);

  log.info('CallServiceV2 initialized for', userEmail);
}

/**
 * _refreshToken()
 * Refreshes the FCM device token on the server.
 * Resolves the ***MISSING*** token error.
 */
async function _refreshToken() {
  try {
    // Get the current FCM token from PushNotificationService
    const token = await PushNotificationService.getToken();
    if (!token) {
      log.warn('No FCM token available to refresh');
      return;
    }

    const result = await api.post(ENDPOINTS_V2.REFRESH_DEVICE_TOKEN, {
      token,
      platform:   Platform.OS,
      appVersion: '2.0.0',
    });

    if (result.ok) {
      log.info(`Token refreshed: action=${result.action} prefix=${result.token_prefix}`);
    } else {
      log.warn('Token refresh failed:', result.error);
    }
  } catch (e) {
    log.warn('_refreshToken error (non-fatal):', e.message);
  }
}

/**
 * cleanup()
 * Call when user logs out.
 */
export function cleanup() {
  stopIncomingPoll();
  _appStateSub?.remove?.();
  _currentUserEmail = null;
  PushNotificationService.cleanup();
  log.info('CallServiceV2 cleaned up');
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTGOING CALLS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * initiateCall({ recipientEmail, recipientName, callType, senderName, senderAvatar })
 *
 * Full pre-flight handshake:
 *   1. Server validates friendship (blocks unfriended calls)
 *   2. Server fetches fresh device token from DB
 *   3. Server creates Daily room + mints tokens
 *   4. Server sends data-only FCM wake push
 *   5. Caller joins WebRTC room
 *   6. Polls for ACK + answer
 */
export async function initiateCall({
  recipientEmail, recipientName, callType = 'voice', senderName, senderAvatar,
}) {
  if (_activeCallId) return { ok: false, error: 'Already in a call' };

  log.info(`initiateCall → ${recipientEmail} type=${callType}`);

  const result = await api.post(ENDPOINTS_V2.PREFLIGHT_INITIATE, {
    recipientEmail, recipientName, callType, senderName, senderAvatar,
  });

  if (!result.ok) {
    log.error('initiateCall API failed:', result.error);
    // Friendly errors for specific codes
    if (result.code === 'FRIENDSHIP_REQUIRED') {
      return { ok: false, error: 'You can only call your friends.', code: 'FRIENDSHIP_REQUIRED' };
    }
    if (result.code === 'UNDER_13_NO_VPC') {
      return { ok: false, error: 'Parental consent required.', code: 'UNDER_13_NO_VPC' };
    }
    return result;
  }

  const { callId, roomUrl, token, iceServers, pollInterval, ringingTimeout } = result;
  _activeCallId  = callId;
  _callStartedAt = null;

  log.info(`Preflight: friendship=${result.preflight?.friendshipVerified} fcm=${result.preflight?.fcmDelivered} signal=${result.preflight?.signalMethod}`);

  // Register outgoing call with native OS (shows in Recents, connects Bluetooth)
  NativeCallBridge.startOutgoingCall(
    callId,
    recipientName || recipientEmail,
    recipientEmail,
    callType === 'video',
  );

  // Join Daily room as caller
  const joinResult = await WebRTCConnectionService.join({
    roomUrl, token, iceServers, callType, callId,
    onEvent: (event, payload) => _handleWebRTCEvent(event, payload),
  });

  if (!joinResult.ok) {
    _activeCallId = null;
    NativeCallBridge.endCall(callId);
    log.error('WebRTC join failed:', joinResult.error);
    return { ok: false, error: joinResult.error };
  }

  // Poll for state transitions: ack_received → connected → declined/missed
  _statusPollTimer = setInterval(async () => {
    try {
      const s = await api.post('/api/getCallStatus', { callId });
      if (!s.ok) return;
      const status = s.status_value || s.call_status;

      if (status === 'ack_received') {
        // Recipient's device received the push — update UI to "connecting..."
        emit('ack_received', { callId });
      } else if (status === 'connected') {
        clearInterval(_statusPollTimer);
        clearTimeout(_ringTimeoutTimer);
        _callStartedAt = Date.now();
        NativeCallBridge.reportCallConnected(callId);
        emit('answered', { callId });
      } else if (['declined', 'missed', 'failed', 'ended'].includes(status)) {
        clearInterval(_statusPollTimer);
        clearTimeout(_ringTimeoutTimer);
        await _cleanupCall(callId);
        const cid = _activeCallId;
        _activeCallId  = null;
        _callStartedAt = null;
        emit(status === 'declined' ? 'declined' : 'missed', { callId: cid });
      }
    } catch (_) {}
  }, pollInterval || POLL.CALL_STATUS);

  // Ring timeout
  _ringTimeoutTimer = setTimeout(async () => {
    clearInterval(_statusPollTimer);
    await api.post(ENDPOINTS.END_CALL, { callId, reason: 'timeout' }).catch(() => {});
    await _cleanupCall(callId);
    const cid = _activeCallId;
    _activeCallId  = null;
    _callStartedAt = null;
    emit('missed', { callId: cid });
  }, ringingTimeout || POLL.RINGING_TIMEOUT);

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// INCOMING CALLS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * _handleIncomingCall(callData)
 * Central handler for ALL incoming call sources:
 *   - FCM data push (killed/background)
 *   - Polling (foreground)
 *   - NativeCallBridge answer event
 */
async function _handleIncomingCall(callData) {
  const callId = callData?.call_id;
  if (!callId) return;

  // Deduplicate
  if (_seenCallIds.has(callId)) return;
  if (_activeCallId === callId) return;
  _seenCallIds.add(callId);
  if (_seenCallIds.size > 50) _seenCallIds.delete(_seenCallIds.values().next().value);

  log.info(`Incoming call detected callId=${callId} type=${callData.call_type}`);

  // Send ACK — tells the caller our device received the call
  api.post(ENDPOINTS_V2.SIGNALING_ACK, {
    callId, state: 'ack_received',
  }).catch(() => {});

  // Show native call UI
  if (_nativeBridgeReady) {
    NativeCallBridge.showIncomingCall(callData);
  } else {
    // Fallback to Notifee
    PushNotificationService.showIncomingCallUI(callData).catch(() => {
      Vibration.vibrate([0, 500, 250, 500, 250, 500], true);
    });
  }

  // Emit to UI (IncomingCallModal etc.)
  emit('incoming', { callData });
}

/**
 * answerCall(callId)
 * Called when user taps Answer (from modal, notification, or native UI).
 */
export async function answerCall(callId) {
  log.info(`answerCall callId=${callId}`);
  Vibration.cancel();
  await PushNotificationService.cancelIncomingCallUI(callId);

  // Send connecting ACK
  api.post(ENDPOINTS_V2.SIGNALING_ACK, { callId, state: 'connecting' }).catch(() => {});

  const result = await api.post(ENDPOINTS.ANSWER_CALL, { callId });
  if (!result.ok) {
    log.error('answerCall API failed:', result.error);
    return result;
  }

  const { roomUrl, token, iceServers, callType } = result;
  _activeCallId  = callId;
  _callStartedAt = Date.now();

  const joinResult = await WebRTCConnectionService.join({
    roomUrl, token, iceServers, callType: callType || 'voice', callId,
    onEvent: (event, payload) => _handleWebRTCEvent(event, payload),
  });

  if (!joinResult.ok) {
    _activeCallId  = null;
    _callStartedAt = null;
    NativeCallBridge.endCall(callId);
    return { ok: false, error: joinResult.error };
  }

  // Tell OS call is now active
  NativeCallBridge.reportCallConnected(callId);

  // Send connected ACK
  api.post(ENDPOINTS_V2.SIGNALING_ACK, { callId, state: 'connected' }).catch(() => {});

  return result;
}

/**
 * declineCall(callId)
 */
export async function declineCall(callId) {
  log.info(`declineCall callId=${callId}`);
  Vibration.cancel();
  NativeCallBridge.endCall(callId);
  await PushNotificationService.cancelIncomingCallUI(callId);
  _seenCallIds.delete(callId);

  api.post(ENDPOINTS_V2.SIGNALING_ACK, { callId, state: 'declined' }).catch(() => {});
  await api.post(ENDPOINTS.END_CALL, { callId, reason: 'declined' }).catch(() => {});
}

/**
 * hangUp(reason)
 */
export async function hangUp(reason = 'hangup') {
  const callId   = _activeCallId;
  const duration = getDurationSeconds();

  clearInterval(_statusPollTimer);
  clearTimeout(_ringTimeoutTimer);

  if (callId) {
    NativeCallBridge.endCall(callId);
    await PushNotificationService.cancelIncomingCallUI(callId);
    api.post(ENDPOINTS_V2.SIGNALING_ACK, { callId, state: 'ended' }).catch(() => {});
    await api.post(ENDPOINTS.END_CALL, { callId, reason }).catch(() => {});
  }

  await _cleanupCall(callId);
  _activeCallId  = null;
  _callStartedAt = null;

  if (callId) emit('ended', { callId, duration, reason });
}

// ─────────────────────────────────────────────────────────────────────────────
// NATIVE BRIDGE CALLBACKS
// ─────────────────────────────────────────────────────────────────────────────

async function _handleNativeAnswer(callData) {
  // User answered from lock screen / native UI
  log.info('[NativeBridge] Answer tapped callId=' + callData?.call_id);
  await answerCall(callData.call_id);
}

async function _handleNativeDecline(callId) {
  log.info('[NativeBridge] Decline tapped callId=' + callId);
  await declineCall(callId);
}

async function _handleNativeEnd(callId) {
  log.info('[NativeBridge] End call event callId=' + callId);
  if (_activeCallId === callId) await hangUp('native_end');
  else await declineCall(callId);
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBRTC EVENTS
// ─────────────────────────────────────────────────────────────────────────────

function _handleWebRTCEvent(event, payload) {
  switch (event) {
    case 'joined':
      log.info('WebRTC joined callId=' + payload?.callId);
      break;
    case 'participant_left':
      hangUp('remote_left');
      break;
    case 'quality':
      emit('quality', payload);
      break;
    case 'reconnecting':
      emit('reconnecting', payload);
      break;
    case 'reconnected':
      emit('reconnected', payload);
      break;
    case 'failed':
      log.error('WebRTC failed:', payload?.message);
      hangUp('webrtc_failed');
      break;
    default:
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INCOMING CALL POLLING (Layer 3 fallback)
// ─────────────────────────────────────────────────────────────────────────────

export function startIncomingPoll(userEmail) {
  if (_isPollingIncoming) return;

  _currentUserEmail  = userEmail;
  _isPollingIncoming = true;
  log.info('Incoming poll started for', userEmail);

  _incomingPollTimer = setInterval(async () => {
    if (!_isPollingIncoming) return;
    try {
      const result = await api.post('/api/getPendingCallNotification', { userEmail });
      const notif  = result?.notification;
      if (!result?.ok || !notif) {
        lastPollResult = { time: Date.now(), found: false, callId: null };
        return;
      }

      const payload = notif.payload || {};
      const callId  = payload.call_id;
      if (!callId) return;

      lastPollResult = { time: Date.now(), found: true, callId };
      await _handleIncomingCall(payload);

    } catch (e) {
      log.warn('Incoming poll error:', e.message);
    }
  }, POLL.INCOMING_CALL);
}

export function stopIncomingPoll() {
  _isPollingIncoming = false;
  if (_incomingPollTimer) {
    clearInterval(_incomingPollTimer);
    _incomingPollTimer = null;
  }
  log.info('Incoming poll stopped');
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLE FCM DATA PUSH (called from your FCM background message handler)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * handleFCMDataMessage(message)
 * Wire this to your FCM background/killed message handler.
 *
 * In App.js (or index.js for killed state):
 *   messaging().setBackgroundMessageHandler(async msg => {
 *     if (msg.data?.type === 'incoming_call_wake') {
 *       await CallServiceV2.handleFCMDataMessage(msg.data);
 *     }
 *   });
 */
export async function handleFCMDataMessage(data) {
  if (data?.type !== 'incoming_call_wake') return;

  log.info('FCM data push received callId=' + data.call_id);

  const callData = {
    call_id:         data.call_id,
    call_type:       data.call_type       || 'voice',
    room_url:        data.room_url         || null,
    room_name:       data.room_name        || null,
    recipient_token: data.recipient_token  || null,
    sender_email:    data.sender_email     || null,
    sender_name:     data.sender_name      || null,
    sender_avatar:   data.sender_avatar    || null,
    ice_servers:     _tryParse(data.ice_servers),
  };

  await _handleIncomingCall(callData);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLS
// ─────────────────────────────────────────────────────────────────────────────

let _isMuted  = false;
let _isCamOff = true;

export function toggleMute() {
  _isMuted = !_isMuted;
  WebRTCConnectionService.setMuted(_isMuted);
  NativeCallBridge.setMuted(_activeCallId, _isMuted);
  return _isMuted;
}

export function toggleCamera() {
  _isCamOff = !_isCamOff;
  WebRTCConnectionService.setCameraEnabled(!_isCamOff);
  return _isCamOff;
}

export function toggleSpeaker() {
  // Implemented via NativeCallBridge (routes through OS audio system)
  NativeCallBridge.setSpeaker(_activeCallId, true);
}

export function isInCall() { return !!_activeCallId; }
export function getActiveCallId() { return _activeCallId; }
export function getCallDuration() { return getDurationSeconds(); }

// ─────────────────────────────────────────────────────────────────────────────

function _tryParse(val) {
  if (!val) return null;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch (_) { return null; }
}

// Default export for drop-in replacement
const CallServiceV2 = {
  initialize, cleanup,
  initiateCall, answerCall, declineCall, hangUp,
  startIncomingPoll, stopIncomingPoll,
  handleFCMDataMessage,
  toggleMute, toggleCamera, toggleSpeaker,
  isInCall, getActiveCallId, getCallDuration,
  addListener,
  lastPollResult,
};

export default CallServiceV2;
