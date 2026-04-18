/**
 * PresenceService.js — OurSpace 2.0 React Native
 * ─────────────────────────────────────────────────────────────────────────────
 * Tracks online/offline status for users.
 *
 * HOW IT WORKS:
 *  - On app foreground: POST /api/updatePresence { status: 'online', userEmail }
 *  - On app background/close: POST /api/updatePresence { status: 'offline' }
 *  - Heartbeat: every 30s while online, so server knows user is still active
 *  - Check another user: GET /api/getPresence?email=X → { is_online, last_seen }
 *  - The backend stores presence in NotificationLedger with type='presence'
 *    OR in a lightweight in-memory store (see presenceUpdate backend function)
 *
 * USAGE:
 *   PresenceService.start(userEmail);   // call after login
 *   PresenceService.stop();             // call on logout
 *   const { is_online } = await PresenceService.getPresence(email);
 *
 * APPSTATE LIFECYCLE:
 *   Automatically switches online/offline when app goes to background/foreground.
 *   Uses AppState from React Native.
 */

import { AppState, Platform } from 'react-native';
import { api, log } from '../config/api';

// ── Constants ─────────────────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS  = 30_000;  // 30s heartbeat
const OFFLINE_DELAY_MS       = 5_000;   // wait 5s before marking offline (handles quick switches)
const PRESENCE_ENDPOINT      = '/api/updatePresence';
const GET_PRESENCE_ENDPOINT  = '/api/getPresence';

// ── Internal state ────────────────────────────────────────────────────────────
let _userEmail        = null;
let _isOnline         = false;
let _heartbeatTimer   = null;
let _offlineDelayTimer = null;
let _appStateUnsub    = null;
let _currentAppState  = AppState.currentState;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * start(userEmail)
 * Begin presence tracking. Call after successful login.
 */
function start(userEmail) {
  if (!userEmail) {
    log.warn('PresenceService.start: userEmail required');
    return;
  }

  _userEmail = userEmail;
  log.info('PresenceService starting for', userEmail);

  // Mark online immediately
  _setOnline();

  // Subscribe to app state changes
  _appStateUnsub = AppState.addEventListener('change', _handleAppStateChange);

  log.info('PresenceService started ✓');
}

/**
 * stop()
 * End presence tracking. Call on logout.
 */
async function stop() {
  _clearHeartbeat();
  clearTimeout(_offlineDelayTimer);
  _appStateUnsub?.remove();
  _appStateUnsub = null;

  if (_userEmail && _isOnline) {
    await _sendPresence('offline');
  }

  _userEmail = null;
  _isOnline  = false;
  log.info('PresenceService stopped');
}

/**
 * getPresence(email)
 * Check if another user is currently online.
 * Returns { is_online: boolean, last_seen: ISO string | null }
 */
async function getPresence(email) {
  try {
    const result = await api.post(GET_PRESENCE_ENDPOINT, { email });
    if (result.ok) {
      return {
        is_online: result.is_online || false,
        last_seen: result.last_seen || null,
      };
    }
    return { is_online: false, last_seen: null };
  } catch (e) {
    log.warn('PresenceService.getPresence error:', e.message);
    return { is_online: false, last_seen: null };
  }
}

/**
 * forceOnline()
 * Manually mark as online (call after network reconnect).
 */
function forceOnline() {
  if (_userEmail && !_isOnline) {
    _setOnline();
  }
}

/**
 * isCurrentlyOnline()
 * Returns whether the local user is marked online.
 */
function isCurrentlyOnline() {
  return _isOnline;
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _handleAppStateChange(nextState) {
  log.debug('AppState change:', _currentAppState, '→', nextState);
  const prev = _currentAppState;
  _currentAppState = nextState;

  if (nextState === 'active') {
    // App came to foreground
    clearTimeout(_offlineDelayTimer);
    if (!_isOnline) _setOnline();
  } else if ((nextState === 'background' || nextState === 'inactive') && prev === 'active') {
    // App went to background
    // Delay slightly to avoid marking offline on quick task-switch
    _offlineDelayTimer = setTimeout(() => {
      _setOffline();
    }, OFFLINE_DELAY_MS);
  }
}

function _setOnline() {
  _isOnline = true;
  _sendPresence('online');
  _startHeartbeat();
}

function _setOffline() {
  _isOnline = false;
  _clearHeartbeat();
  _sendPresence('offline');
}

function _startHeartbeat() {
  _clearHeartbeat();
  _heartbeatTimer = setInterval(() => {
    if (_isOnline && _userEmail) {
      _sendPresence('online').catch(() => {});
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function _clearHeartbeat() {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}

async function _sendPresence(status) {
  if (!_userEmail) return;
  try {
    await api.post(PRESENCE_ENDPOINT, {
      userEmail: _userEmail,
      status,
      platform: Platform.OS,
      timestamp: new Date().toISOString(),
    });
    log.debug('Presence updated:', status);
  } catch (e) {
    log.warn('_sendPresence error:', e.message);
  }
}

export default {
  start,
  stop,
  getPresence,
  forceOnline,
  isCurrentlyOnline,
};
