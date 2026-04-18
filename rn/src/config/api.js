/**
 * src/config/api.js — OurSpace 2.0 · Zero-Redirection v2
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for all API config, endpoints, and polling intervals.
 * All network calls in the app go through apiFetch() — one place for auth,
 * base URL, error normalisation, and request logging.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Base URL ──────────────────────────────────────────────────────────────────
export const BASE_URL    = 'https://face-app-0b743c8e.base44.app';
export const DAILY_DOMAIN = 'dixson2424.daily.co'; // for reference only

// ── Polling config (ms) ───────────────────────────────────────────────────────
export const POLL = {
  INCOMING_CALL:    2000,   // recipient: check for new incoming calls
  CALL_STATUS:      1500,   // caller: check for answer / ack / decline
  RINGING_TIMEOUT:  50000,  // 50s ring window (matches server RING_TTL_MS)
  NOTIFICATION_TTL: 50000,  // auto-dismiss incoming modal after this
  HEARTBEAT:        30000,  // presence heartbeat
};

// ── Logger ─────────────────────────────────────────────────────────────────────
const PREFIX = '[OurSpace]';
export const log = {
  info:  (...a) => console.log(PREFIX,         ...a),
  warn:  (...a) => console.warn(PREFIX,        ...a),
  error: (...a) => console.error(PREFIX,       ...a),
  debug: (...a) => __DEV__ && console.log(`${PREFIX}[dbg]`, ...a),
};

// ── Auth helpers ───────────────────────────────────────────────────────────────
export async function getAuthToken() {
  try { return await AsyncStorage.getItem('ourspace_auth_token'); }
  catch (e) { log.error('getAuthToken:', e.message); return null; }
}
export async function setAuthToken(token) {
  await AsyncStorage.setItem('ourspace_auth_token', token);
}
export async function clearAuthToken() {
  await AsyncStorage.removeItem('ourspace_auth_token');
}

// ── Core fetch ─────────────────────────────────────────────────────────────────
export async function apiFetch(path, options = {}) {
  const token = await getAuthToken();
  const url   = `${BASE_URL}${path}`;

  const headers = {
    'Content-Type': 'application/json',
    Accept:         'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };

  const config = {
    method: options.method || 'POST',
    headers,
    ...(options.data || options.body
      ? { body: JSON.stringify(options.data || options.body) }
      : {}),
  };

  log.debug(`→ ${config.method} ${path}`, options.data || '');
  const t0 = Date.now();
  let response;

  try {
    response = await fetch(url, config);
  } catch (netErr) {
    log.error(`Network error on ${path}:`, netErr.message);
    return { ok: false, error: 'Network error — check your connection', networkError: true };
  }

  const latency = Date.now() - t0;
  log.debug(`← ${response.status} ${path} (${latency}ms)`);

  let parsed;
  const ct = response.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { parsed = await response.json(); } catch { parsed = {}; }
  } else {
    parsed = { raw: await response.text() };
  }

  if (!response.ok) {
    log.warn(`API error ${response.status} ${path}:`, parsed);
    return { ok: false, status: response.status, error: parsed?.error || parsed?.message || `HTTP ${response.status}`, code: parsed?.code, ...parsed };
  }

  return { ok: true, status: response.status, latency, ...parsed };
}

// ── Shorthands ─────────────────────────────────────────────────────────────────
export const api = {
  post: (path, data) => apiFetch(path, { method: 'POST', data }),
  get:  (path)       => apiFetch(path, { method: 'GET'         }),
};

// ── Endpoints ──────────────────────────────────────────────────────────────────
// v1 (still active)
export const ENDPOINTS = {
  INITIATE_CALL:    '/api/initiateCall',          // legacy — use PREFLIGHT_INITIATE
  ANSWER_CALL:      '/api/answerCall',
  END_CALL:         '/api/endCall',
  GET_CALL_STATUS:  '/api/getCallStatus',
  CALL_QUALITY_LOG: '/api/callQualityLog',
  VOIP_CONFIG:      '/api/voipConfig',
  REGISTER_PUSH:    '/api/registerPushToken',
  GET_ICE_SERVERS:  '/api/getIceServers',
  CHECK_CONSENT:    '/api/checkConsentStatus',
  REQUEST_CONSENT:  '/api/requestParentalConsent',
  UPDATE_PRESENCE:  '/api/updatePresence',
  GET_PRESENCE:     '/api/getPresence',
  GET_PENDING_CALL: '/api/getPendingCallNotification',
};

// v2 — Zero-Redirection
export const ENDPOINTS_V2 = {
  PREFLIGHT_INITIATE:   '/api/preflightAndInitiateCall',  // ← use this for all new calls
  SIGNALING_ACK:        '/api/signalingAck',
  REFRESH_DEVICE_TOKEN: '/api/refreshDeviceToken',
};
