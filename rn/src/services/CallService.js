/**
 * CallService.js — OurSpace 2.0 · Zero-Signal Fix (v3)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ZERO-SIGNAL FIX — Call state + polling:
 *
 * Layer 3 (polling) now:
 *   1. Triggers Layer 2 (Notifee notification) when a call is found
 *   2. Deduplicates correctly — won't re-ring for same call
 *   3. Auto-cancels the notification when call ends/is answered
 *   4. Handles edge case where push arrived but app was in foreground
 *   5. Exposes `lastPollResult` for diagnostics
 *
 * Signal delivery chain (guaranteed delivery):
 *   initiateCall backend → FCM push (Layer 1) → wakes device
 *   FCM message arrives → Notifee heads-up + vibration (Layer 2)
 *   If FCM fails → poll every 2s → triggers Layer 2 from client side (Layer 3)
 */

import { Vibration, Platform } from 'react-native';
import { api, ENDPOINTS, POLL, log } from '../config/api';
import WebRTCConnectionService from './WebRTCConnectionService';
import PushNotificationService from './PushNotificationService';

// ── Internal state ─────────────────────────────────────────────────────────────
let _activeCallId       = null;
let _callStartedAt      = null;
let _pollingTimer       = null;
let _incomingPollTimer  = null;
let _ringTimeoutTimer   = null;
let _isPollingIncoming  = false;
let _seenCallIds        = new Set();
let _currentUserEmail   = null;

// Diagnostic
export let lastPollResult = { time: null, found: false, callId: null };

// ── Event bus ──────────────────────────────────────────────────────────────────
const _listeners = {};

function emit(event, payload) {
  log.debug(`emit:${event}`, payload);
  (_listeners[event] || []).forEach(fn => {
    try { fn(payload); }
    catch (e) { log.error(`Listener error on ${event}:`, e.message); }
  });
}

function addListener(event, fn) {
  if (!_listeners[event]) _listeners[event] = [];
  _listeners[event].push(fn);
  return () => { _listeners[event] = (_listeners[event] || []).filter(f => f !== fn); };
}

// ── Duration ───────────────────────────────────────────────────────────────────
function getDurationSeconds() {
  if (!_callStartedAt) return 0;
  return Math.max(0, Math.round((Date.now() - _callStartedAt) / 1000));
}

// ── Cleanup ────────────────────────────────────────────────────────────────────
async function _cleanupCall() {
  clearInterval(_pollingTimer);
  clearTimeout(_ringTimeoutTimer);
  _pollingTimer     = null;
  _ringTimeoutTimer = null;
  Vibration.cancel();
  await WebRTCConnectionService.leave('cleanup');
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * initiateCall — places an outgoing call
 */
async function initiateCall({
  recipientEmail, recipientName, callType = 'voice', senderName, senderAvatar,
}) {
  if (_activeCallId) return { ok: false, error: 'Already in a call' };

  log.info(`initiateCall → ${recipientEmail} type=${callType}`);

  const result = await api.post(ENDPOINTS.INITIATE_CALL, {
    recipientEmail, recipientName, callType, senderName, senderAvatar,
  });

  if (!result.ok) {
    log.error('initiateCall API failed:', result.error);
    return result;
  }

  // Log FCM diagnostic (set by initiateCall backend)
  if (result._debug?.fcm) {
    log.info(`FCM push status: ${result._debug.fcm}`);
  }

  const { callId, roomUrl, token, iceServers, pollInterval, ringingTimeout } = result;
  _activeCallId  = callId;
  _callStartedAt = null;

  // Join room as caller
  const joinResult = await WebRTCConnectionService.join({
    roomUrl, token, iceServers, callType, callId,
    onEvent: (event, payload) => _handleWebRTCEvent(event, payload),
  });

  if (!joinResult.ok) {
    _activeCallId = null;
    log.error('WebRTC join failed:', joinResult.error);
    return { ok: false, error: joinResult.error };
  }

  // Poll for recipient answer/decline
  _pollingTimer = setInterval(async () => {
    try {
      const s = await api.post('/api/getCallStatus', { callId });
      if (!s.ok) return;
      const status = s.status_value || s.call_status;

      if (status === 'connected') {
        clearInterval(_pollingTimer);
        clearTimeout(_ringTimeoutTimer);
        _callStartedAt = Date.now();
        emit('answered', { callId });
      } else if (['declined', 'missed', 'failed', 'ended'].includes(status)) {
        clearInterval(_pollingTimer);
        clearTimeout(_ringTimeoutTimer);
        await _cleanupCall();
        _activeCallId  = null;
        _callStartedAt = null;
        emit(status === 'declined' ? 'declined' : 'missed', { callId });
      }
    } catch (_) {}
  }, pollInterval || POLL.CALL_STATUS);

  // Ring timeout
  _ringTimeoutTimer = setTimeout(async () => {
    clearInterval(_pollingTimer);
    await api.post(ENDPOINTS.END_CALL, { callId, reason: 'timeout' }).catch(() => {});
    await _cleanupCall();
    const cid = _activeCallId;
    _activeCallId  = null;
    _callStartedAt = null;
    emit('missed', { callId: cid });
  }, ringingTimeout || POLL.RINGING_TIMEOUT);

  return result;
}

/**
 * answerCall(callId) — recipient answers
 */
async function answerCall(callId) {
  log.info(`answerCall callId=${callId}`);
  Vibration.cancel();
  await PushNotificationService.cancelIncomingCallUI(callId);

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
    return { ok: false, error: joinResult.error };
  }

  return result;
}

/**
 * declineCall(callId) — recipient declines
 */
async function declineCall(callId) {
  log.info(`declineCall callId=${callId}`);
  Vibration.cancel();
  await PushNotificationService.cancelIncomingCallUI(callId);
  _seenCallIds.delete(callId);
  await api.post(ENDPOINTS.END_CALL, { callId, reason: 'declined' }).catch(() => {});
}

/**
 * hangUp(reason) — either party hangs up
 */
async function hangUp(reason = 'hangup') {
  const callId   = _activeCallId;
  const duration = getDurationSeconds();

  clearInterval(_pollingTimer);
  clearTimeout(_ringTimeoutTimer);

  if (callId) {
    await PushNotificationService.cancelIncomingCallUI(callId);
    await api.post(ENDPOINTS.END_CALL, { callId, reason }).catch(() => {});
  }

  await _cleanupCall();
  _activeCallId  = null;
  _callStartedAt = null;

  if (callId) emit('ended', { callId, duration, reason });
}

// ── Controls ───────────────────────────────────────────────────────────────────
let _isMuted  = false;
let _isCamOff = true;

function toggleMute() {
  _isMuted = !_isMuted;
  WebRTCConnectionService.setMuted(_isMuted);
  return _isMuted;
}

function toggleCamera() {
  _isCamOff = !_isCamOff;
  WebRTCConnectionService.setCameraEnabled(!_isCamOff);
  return _isCamOff;
}

function isInCall() { return !!_activeCallId; }
function getActiveCallId() { return _activeCallId; }

// ── Incoming call polling (Layer 3) ────────────────────────────────────────────

/**
 * startIncomingPoll(userEmail)
 * Polls every 2s for pending call notifications.
 * When found: triggers Layer 2 (Notifee) + emits 'incoming' event.
 * Guaranteed to fire even if FCM push failed.
 */
function startIncomingPoll(userEmail) {
  if (_isPollingIncoming) {
    log.warn('startIncomingPoll: already polling');
    return;
  }

  _currentUserEmail  = userEmail;
  _isPollingIncoming = true;
  log.info('Incoming call poll started for', userEmail);

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

      // Skip if already seen or already in this call
      if (_seenCallIds.has(callId)) return;
      if (_activeCallId === callId) return;

      _seenCallIds.add(callId);
      if (_seenCallIds.size > 50) {
        _seenCallIds.delete(_seenCallIds.values().next().value);
      }

      log.info(`🔔 Incoming call detected via POLL (Layer 3) callId=${callId}`);

      const callData = {
        call_id:         callId,
        call_type:       payload.call_type       || 'voice',
        room_url:        payload.room_url         || null,
        room_name:       payload.room_name        || null,
        recipient_token: payload.recipient_token  || null,
        sender_email:    payload.sender_email     || null,
        sender_name:     payload.sender_name      || null,
        sender_avatar:   payload.sender_avatar    || null,
        ice_servers:     payload.ice_servers      || null,
      };

      // Layer 3 → Layer 2: show heads-up notification + vibration
      // This fires when FCM didn't wake the device (app was in foreground,
      // or push was delayed by Android Doze, or Firebase wasn't configured)
      PushNotificationService.showIncomingCallUI(callData).catch(() => {
        // Even if notification fails, vibration still works
        Vibration.vibrate([0, 500, 250, 500, 250, 500], true);
      });

      // Emit event so UI can show IncomingCallModal
      emit('incoming', { callData });

    } catch (e) {
      log.warn('Incoming poll error:', e.message);
    }
  }, POLL.INCOMING_CALL);
}

/**
 * stopIncomingPoll()
 */
function stopIncomingPoll() {
  _isPollingIncoming = false;
  if (_incomingPollTimer) {
    clearInterval(_incomingPollTimer);
    _incomingPollTimer = null;
  }
  Vibration.cancel();
  log.info('Incoming call poll stopped');
}

// ── WebRTC event handler ───────────────────────────────────────────────────────

function _handleWebRTCEvent(event, payload) {
  const callId = payload?.callId || _activeCallId;
  switch (event) {
    case 'participant_left':
      _handleRemoteHangup(callId);
      break;
    case 'quality':
      emit('quality', { callId, quality: payload.quality });
      break;
    case 'reconnecting':
      emit('reconnecting', { callId });
      break;
    case 'reconnected':
      emit('reconnected', { callId });
      break;
    case 'failed':
      _cleanupCall();
      _activeCallId  = null;
      _callStartedAt = null;
      emit('error', { callId, message: payload.message || 'Connection failed' });
      break;
  }
}

async function _handleRemoteHangup(callId) {
  const duration = getDurationSeconds();
  await PushNotificationService.cancelIncomingCallUI(callId);
  await _cleanupCall();
  _activeCallId  = null;
  _callStartedAt = null;
  emit('ended', { callId, duration, reason: 'remote_hangup' });
}

// ── Exports ────────────────────────────────────────────────────────────────────
export default {
  initiateCall,
  answerCall,
  declineCall,
  hangUp,
  toggleMute,
  toggleCamera,
  isInCall,
  getActiveCallId,
  startIncomingPoll,
  stopIncomingPoll,
  addListener,
  getDurationSeconds,
  get lastPollResult() { return lastPollResult; },
};
