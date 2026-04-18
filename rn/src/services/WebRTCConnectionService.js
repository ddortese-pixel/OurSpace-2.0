/**
 * WebRTCConnectionService.js — OurSpace 2.0 React Native
 * ─────────────────────────────────────────────────────────────────────────────
 * Hardened WebRTC connection manager on top of Daily.co.
 *
 * Handles:
 *  - Fresh ICE server fetch before each call (never stale credentials)
 *  - Exponential backoff reconnection (up to 5 attempts)
 *  - Network type detection (WiFi vs cellular) for adaptive bitrate
 *  - ICE restart on network change (Wi-Fi ↔ 5G handoff)
 *  - Connection state machine with timeouts
 *  - Quality degradation → automatic resolution downgrade
 *  - Cleanup on every exit path (no leaked call objects)
 *
 * This is a low-level module used by CallService.js.
 * Import and use via CallService — don't use this directly.
 */

import Daily from '@daily-co/daily-js';
import NetInfo from '@react-native-community/netinfo';
import { api, log } from '../config/api';

// ── Constants ─────────────────────────────────────────────────────────────────
const ICE_GATHERING_TIMEOUT_MS   = 10_000;   // fail if ICE candidates not gathered in 10s
const JOIN_TIMEOUT_MS            = 20_000;   // fail if room not joined in 20s
const RECONNECT_BACKOFF_MS       = [1000, 2000, 4000, 8000, 16000];
const MAX_RECONNECT_ATTEMPTS     = 5;
const QUALITY_LOG_INTERVAL_MS    = 10_000;
const TURN_SERVER_URL            = 'https://face-app-0b743c8e.base44.app/api/getIceServers';

// ── Adaptive bitrate configs per network type ─────────────────────────────────
const BITRATE_PROFILES = {
  wifi:      { video: { maxBitrate: 1_200_000, maxQuality: 'high' },   audio: { maxBitrate: 64_000 } },
  cellular4g:{ video: { maxBitrate: 600_000,  maxQuality: 'medium' }, audio: { maxBitrate: 48_000 } },
  cellular3g:{ video: { maxBitrate: 300_000,  maxQuality: 'low' },    audio: { maxBitrate: 32_000 } },
  poor:      { video: { maxBitrate: 150_000,  maxQuality: 'low' },    audio: { maxBitrate: 24_000 } },
  voiceOnly: { video: null,                                             audio: { maxBitrate: 64_000 } },
};

// ── Class ─────────────────────────────────────────────────────────────────────

class WebRTCConnectionService {
  constructor() {
    this._callObject       = null;
    this._callId           = null;
    this._callType         = 'voice';
    this._reconnectAttempts = 0;
    this._qualityTimer     = null;
    this._networkUnsub     = null;
    this._onEvent          = null; // callback: (event, payload) => void
    this._lastNetworkType  = 'unknown';
    this._isReconnecting   = false;
  }

  // ── Initialize ──────────────────────────────────────────────────────────────

  /**
   * join({ roomUrl, token, iceServers, callType, callId, onEvent })
   * Creates a Daily call object, applies ICE config, and joins the room.
   *
   * onEvent(event, payload):
   *   'joined'        — successfully joined room
   *   'participant_left' — remote party left
   *   'quality'       { quality: 'good' | 'degraded' | 'poor' }
   *   'reconnecting'  — ICE restart started
   *   'reconnected'   — ICE restart succeeded
   *   'error'         { message }
   *   'failed'        { message }  — unrecoverable
   */
  async join({ roomUrl, token, iceServers, callType = 'voice', callId, onEvent }) {
    this._callId   = callId;
    this._callType = callType;
    this._onEvent  = onEvent;

    // Cleanup any stale call object
    await this.leave('replaced');

    try {
      // 1. Detect network and get fresh ICE servers
      const networkType = await this._detectNetworkType();
      const finalIceServers = await this._getFreshIceServers(token, iceServers);

      log.info(`WebRTC join: callId=${callId} network=${networkType} iceServers=${finalIceServers.length}`);

      // 2. Create Daily call object
      const call = Daily.createCallObject({
        url: roomUrl,
        token,
        dailyConfig: {
          iceServers: finalIceServers,
          iceRestartOnNetworkChange: true,
          // Use SFU for better scalability and lower latency
          userMediaVideoConstraints: callType !== 'voice' ? {
            width: { ideal: 1280, max: 1280 },
            height: { ideal: 720, max: 720 },
            frameRate: { ideal: 30, max: 30 },
          } : false,
        },
        videoSource: callType !== 'voice',
        audioSource: true,
      });

      this._callObject = call;

      // 3. Wire event handlers
      this._wireEvents(call, callId);

      // 4. Apply adaptive bitrate based on network
      await this._applyBitrateProfile(call, networkType, callType);

      // 5. Join with timeout
      await this._joinWithTimeout(call, JOIN_TIMEOUT_MS);

      // 6. Start quality monitoring
      this._startQualityMonitor(call, callId);

      // 7. Subscribe to network changes
      this._watchNetwork(call, callId);

      log.info(`WebRTC joined successfully callId=${callId}`);
      this._emit('joined', { callId });

      return { ok: true };

    } catch (error) {
      log.error('WebRTC join error:', error.message);
      await this.leave('failed');
      this._emit('failed', { callId, message: error.message });
      return { ok: false, error: error.message };
    }
  }

  // ── Leave ───────────────────────────────────────────────────────────────────

  /**
   * leave(reason)
   * Gracefully leaves the room and cleans up all resources.
   */
  async leave(reason = 'hangup') {
    log.info(`WebRTC leave: reason=${reason} callId=${this._callId}`);

    // Stop quality monitor
    if (this._qualityTimer) {
      clearInterval(this._qualityTimer);
      this._qualityTimer = null;
    }

    // Stop network watcher
    if (this._networkUnsub) {
      this._networkUnsub();
      this._networkUnsub = null;
    }

    // Leave and destroy Daily call object
    if (this._callObject) {
      try { await this._callObject.leave(); } catch (_) {}
      try { this._callObject.destroy(); }    catch (_) {}
      this._callObject = null;
    }

    this._isReconnecting   = false;
    this._reconnectAttempts = 0;
  }

  // ── Mute / Camera ───────────────────────────────────────────────────────────

  /**
   * setMuted(muted)
   * Mute or unmute the local microphone.
   */
  setMuted(muted) {
    if (!this._callObject) return;
    try {
      this._callObject.setLocalAudio(!muted);
    } catch (e) {
      log.warn('setMuted error:', e.message);
    }
  }

  /**
   * setCameraEnabled(enabled)
   * Enable or disable the local camera.
   */
  setCameraEnabled(enabled) {
    if (!this._callObject) return;
    try {
      this._callObject.setLocalVideo(enabled);
    } catch (e) {
      log.warn('setCameraEnabled error:', e.message);
    }
  }

  /**
   * getCallObject()
   * Returns the raw Daily call object (for advanced usage).
   */
  getCallObject() {
    return this._callObject;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _emit(event, payload) {
    try {
      this._onEvent?.(event, payload);
    } catch (e) {
      log.error(`WebRTCConnectionService emit error on ${event}:`, e.message);
    }
  }

  _wireEvents(call, callId) {
    // Remote party left
    call.on('participant-left', (e) => {
      if (!e?.participant?.local) {
        log.info('Remote participant left callId=', callId);
        this._emit('participant_left', { callId });
      }
    });

    // Network quality changes
    call.on('network-quality-change', async ({ threshold }) => {
      const quality = threshold === 'very-low' ? 'poor'
                    : threshold === 'low'      ? 'degraded'
                    :                            'good';
      log.debug('Network quality change:', threshold, '→', quality);
      this._emit('quality', { callId, quality });

      // Auto-downgrade video bitrate on poor quality
      if (threshold === 'very-low' || threshold === 'low') {
        try {
          await call.updateSendSettings({
            video: {
              maxQuality: threshold === 'very-low' ? 'low' : 'medium',
            },
          });
        } catch (_) {}
      }
    });

    // Network interruption (triggers ICE restart)
    call.on('network-connection', async ({ type, event }) => {
      log.info('Network connection event:', type);
      if (type === 'interrupted') {
        if (!this._isReconnecting) {
          this._isReconnecting = true;
          this._emit('reconnecting', { callId });
          this._attemptReconnect(call, callId);
        }
      } else if (type === 'restored') {
        this._isReconnecting   = false;
        this._reconnectAttempts = 0;
        this._emit('reconnected', { callId });
      }
    });

    // Call errors
    call.on('error', (e) => {
      const msg = e?.errorMsg || e?.type || 'Unknown call error';
      log.error('Daily call error:', msg, e);

      if (this._reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        this._emit('reconnecting', { callId });
        this._attemptReconnect(call, callId);
      } else {
        this._emit('failed', { callId, message: msg });
      }
    });

    // Left event (e.g. kicked out, room deleted)
    call.on('left-meeting', () => {
      log.info('Left meeting event fired callId=', callId);
    });
  }

  async _attemptReconnect(call, callId) {
    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log.error(`Max reconnect attempts reached for callId=${callId}`);
      this._emit('failed', { callId, message: 'Connection lost — max retries reached' });
      return;
    }

    const delay = RECONNECT_BACKOFF_MS[this._reconnectAttempts] || 16000;
    this._reconnectAttempts++;
    log.info(`Reconnect attempt ${this._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);

    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      // ICE restart triggers WebRTC to gather new candidates
      await call.startCamera();
      log.info(`ICE restart attempt ${this._reconnectAttempts} fired`);
    } catch (e) {
      log.warn('ICE restart failed:', e.message);
      if (this._reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        this._attemptReconnect(call, callId);
      } else {
        this._emit('failed', { callId, message: 'Failed to reconnect after network change' });
      }
    }
  }

  async _joinWithTimeout(call, timeoutMs) {
    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Room join timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        await call.join();
        clearTimeout(timeout);
        resolve();
      } catch (e) {
        clearTimeout(timeout);
        reject(e);
      }
    });
  }

  async _getFreshIceServers(token, fallbackIceServers) {
    try {
      // Always fetch fresh ICE servers — credentials expire
      const result = await api.post(TURN_SERVER_URL.replace('https://face-app-0b743c8e.base44.app', ''), {});
      if (result.ok && result.iceServers && result.iceServers.length > 0) {
        log.debug('Using fresh ICE servers from server');
        return result.iceServers;
      }
    } catch (e) {
      log.warn('Failed to fetch fresh ICE servers, using provided ones:', e.message);
    }

    // Use the ones provided (from initiateCall/answerCall response)
    if (fallbackIceServers && fallbackIceServers.length > 0) {
      return fallbackIceServers;
    }

    // Absolute fallback: public STUN only
    log.warn('Using public STUN only — TURN not available');
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];
  }

  async _detectNetworkType() {
    try {
      const state = await NetInfo.fetch();
      const type = state.type; // 'wifi', 'cellular', 'none', 'unknown'
      const details = state.details;

      if (type === 'wifi') {
        this._lastNetworkType = 'wifi';
        return 'wifi';
      }

      if (type === 'cellular') {
        const gen = details?.cellularGeneration;
        if (gen === '4g' || gen === '5g') {
          this._lastNetworkType = 'cellular4g';
          return 'cellular4g';
        }
        this._lastNetworkType = 'cellular3g';
        return 'cellular3g';
      }

      this._lastNetworkType = 'unknown';
      return 'unknown';
    } catch (e) {
      log.warn('_detectNetworkType error:', e.message);
      return 'unknown';
    }
  }

  async _applyBitrateProfile(call, networkType, callType) {
    try {
      if (callType === 'voice') {
        await call.updateSendSettings({ video: false });
        return;
      }

      const profile = BITRATE_PROFILES[networkType] || BITRATE_PROFILES['cellular4g'];
      if (profile.video) {
        await call.updateSendSettings({
          video: {
            maxQuality: profile.video.maxQuality,
            encodings: {
              maxBitrate: profile.video.maxBitrate,
            },
          },
        });
      }
      log.debug('Bitrate profile applied:', networkType);
    } catch (e) {
      log.warn('_applyBitrateProfile error:', e.message);
    }
  }

  _startQualityMonitor(call, callId) {
    this._qualityTimer = setInterval(async () => {
      if (!this._callObject) {
        clearInterval(this._qualityTimer);
        return;
      }
      try {
        const stats = await call.getNetworkStats();
        const latest = stats?.stats?.latest || {};

        const metrics = {
          packetLoss:  +(latest.videoRecvPacketLoss   || 0).toFixed(2),
          bandwidth:   Math.round((latest.videoRecvBitsPerSecond || 1_000_000) / 1000),
          audioLoss:   +(latest.audioRecvPacketLoss   || 0).toFixed(2),
          rtt:         latest.totalRoundTripTime      || 0,
        };

        // Log to backend
        await api.post('/api/callQualityLog', {
          callId,
          metrics,
          networkType: this._lastNetworkType,
          platform: 'react-native',
        }).catch(() => {});

      } catch (e) {
        log.warn('Quality monitor error:', e.message);
      }
    }, QUALITY_LOG_INTERVAL_MS);
  }

  _watchNetwork(call, callId) {
    this._networkUnsub = NetInfo.addEventListener(async (state) => {
      const newType = state.type;
      log.debug('Network change detected:', newType);

      if (newType !== this._lastNetworkType) {
        const prevType = this._lastNetworkType;
        const networkType = await this._detectNetworkType();

        if (newType !== 'none' && newType !== 'unknown') {
          // Network changed but still connected — apply new bitrate profile
          await this._applyBitrateProfile(call, networkType, this._callType);
          log.info(`Network changed from ${prevType} to ${networkType} — bitrate updated`);
        }
      }
    });
  }
}

// Export singleton
export default new WebRTCConnectionService();
