/**
 * CallModal.js — OurSpace 2.0 · Zero-Redirection v2
 * ─────────────────────────────────────────────────────────────────────────────
 * Full-screen outgoing call overlay — ZERO REDIRECTION, fully in-app.
 *
 * Updated for v2:
 *   - Uses CallServiceV2 (pre-flight handshake + ACK signaling)
 *   - Shows ACK state: "Device awake — connecting..." when ack_received fires
 *   - Shows friendship error with clear message (server-enforced)
 *   - Dynamic TURN / SFU connection (no hardcoded servers)
 *   - Native call UI registered via NativeCallBridge (Bluetooth, lock screen)
 *
 * States: idle → calling → ringing → ack → connecting → connected → ended
 *
 * Props:
 *   visible                boolean
 *   onClose                () => void
 *   recipientEmail         string
 *   recipientName          string
 *   recipientAvatar        string | null
 *   callType               'voice' | 'video'
 *   currentUser            { email, name, avatar }
 *   preConnectedCallId     string | undefined  (for answered incoming calls)
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet,
  Animated, Easing, Image, StatusBar, Platform, Alert,
} from 'react-native';
import CallServiceV2 from '../services/CallServiceV2';
import { log } from '../config/api';

// ── State constants ────────────────────────────────────────────────────────────
const S = {
  IDLE:         'idle',
  CALLING:      'calling',
  RINGING:      'ringing',
  ACK:          'ack',          // device confirmed awake
  CONNECTING:   'connecting',
  CONNECTED:    'connected',
  RECONNECTING: 'reconnecting',
  ENDING:       'ending',
  ENDED:        'ended',
};

const STATE_LABEL = {
  [S.IDLE]:         '',
  [S.CALLING]:      'Connecting...',
  [S.RINGING]:      'Ringing...',
  [S.ACK]:          'Device awake — connecting...',
  [S.CONNECTING]:   'Connecting call...',
  [S.CONNECTED]:    'Connected',
  [S.RECONNECTING]: 'Reconnecting...',
  [S.ENDING]:       'Ending call...',
  [S.ENDED]:        'Call ended',
};

function fmt(s) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function Avatar({ name, uri, size, pulse }) {
  const initials = (name || '?').split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
  const scale = pulse
    ? pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.1] })
    : 1;
  return (
    <Animated.View style={[
      styles.avatarWrap,
      { width: size, height: size, borderRadius: size / 2, transform: [{ scale }] },
    ]}>
      {uri
        ? <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2 }} />
        : <Text style={[styles.avatarText, { fontSize: size * 0.36 }]}>{initials}</Text>
      }
    </Animated.View>
  );
}

function CtrlBtn({ onPress, bg, label, icon, disabled }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.75}
      accessibilityLabel={label}
      accessibilityRole="button"
      style={[styles.ctrlBtn, { backgroundColor: bg }, disabled && { opacity: 0.4 }]}
    >
      <Text style={styles.ctrlIcon}>{icon}</Text>
    </TouchableOpacity>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function CallModal({
  visible,
  onClose,
  recipientEmail,
  recipientName,
  recipientAvatar,
  callType = 'voice',
  currentUser,
  preConnectedCallId,
}) {
  const [callState,  setCallState]  = useState(S.IDLE);
  const [callId,     setCallId]     = useState(null);
  const [isMuted,    setIsMuted]    = useState(false);
  const [isCamOff,   setIsCamOff]   = useState(callType === 'voice');
  const [duration,   setDuration]   = useState(0);
  const [statusMsg,  setStatusMsg]  = useState('');
  const [quality,    setQuality]    = useState('good');
  const [errorMsg,   setErrorMsg]   = useState('');
  const [signalInfo, setSignalInfo] = useState(null); // { method, friendshipVerified }

  const pulseAnim   = useRef(new Animated.Value(0)).current;
  const fadeAnim    = useRef(new Animated.Value(0)).current;
  const durationRef = useRef(null);
  const callIdRef   = useRef(null);

  // ── Animations ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if ([S.RINGING, S.ACK].includes(callState)) {
      const p = Animated.loop(Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]));
      p.start();
      return () => p.stop();
    }
  }, [callState]);

  useEffect(() => {
    if (visible) {
      Animated.timing(fadeAnim, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    } else {
      fadeAnim.setValue(0);
    }
  }, [visible]);

  // ── Duration timer ───────────────────────────────────────────────────────────
  const startTimer = useCallback(() => {
    setDuration(0);
    durationRef.current = setInterval(() => setDuration(d => d + 1), 1000);
  }, []);

  const stopTimer = useCallback(() => {
    clearInterval(durationRef.current);
    durationRef.current = null;
  }, []);

  // ── Event listeners ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!visible) return;

    const unsubs = [
      // Caller: recipient device confirmed awake
      CallServiceV2.addListener('ack_received', ({ callId: cid }) => {
        if (cid !== callIdRef.current) return;
        setCallState(S.ACK);
        setStatusMsg(STATE_LABEL[S.ACK]);
      }),

      // Caller: call answered
      CallServiceV2.addListener('answered', ({ callId: cid }) => {
        if (cid !== callIdRef.current) return;
        setCallState(S.CONNECTED);
        setStatusMsg(STATE_LABEL[S.CONNECTED]);
        startTimer();
      }),

      // Caller: call declined by recipient
      CallServiceV2.addListener('declined', ({ callId: cid }) => {
        if (cid !== callIdRef.current) return;
        stopTimer();
        setStatusMsg('Call declined');
        setCallState(S.ENDED);
        setTimeout(_doClose, 2000);
      }),

      // Caller: no answer (timeout)
      CallServiceV2.addListener('missed', ({ callId: cid }) => {
        if (cid !== callIdRef.current) return;
        stopTimer();
        setStatusMsg('No answer');
        setCallState(S.ENDED);
        setTimeout(_doClose, 2000);
      }),

      // Either: call ended
      CallServiceV2.addListener('ended', ({ callId: cid }) => {
        if (cid !== callIdRef.current) return;
        stopTimer();
        setStatusMsg('Call ended');
        setCallState(S.ENDED);
        setTimeout(_doClose, 1800);
      }),

      // Quality changes
      CallServiceV2.addListener('quality', ({ callId: cid, quality: q }) => {
        if (cid !== callIdRef.current) return;
        setQuality(q);
        if (q === 'poor')     setStatusMsg('⚠️ Weak signal');
        else if (q === 'degraded') setStatusMsg('Connection degraded');
        else setStatusMsg('Connected');
      }),

      // Reconnecting
      CallServiceV2.addListener('reconnecting', ({ callId: cid }) => {
        if (cid !== callIdRef.current) return;
        setCallState(S.RECONNECTING);
        setStatusMsg(STATE_LABEL[S.RECONNECTING]);
      }),
      CallServiceV2.addListener('reconnected', ({ callId: cid }) => {
        if (cid !== callIdRef.current) return;
        setCallState(S.CONNECTED);
        setStatusMsg('Connected');
      }),

      // Error
      CallServiceV2.addListener('error', ({ callId: cid, message }) => {
        if (cid !== callIdRef.current) return;
        stopTimer();
        setErrorMsg(message || 'Call failed');
        setCallState(S.ENDED);
        setTimeout(_doClose, 3000);
      }),
    ];

    return () => unsubs.forEach(u => u());
  }, [visible]);

  // ── Auto-start or pre-connect ─────────────────────────────────────────────
  useEffect(() => {
    if (!visible) return;

    if (preConnectedCallId) {
      // Answered incoming call — already connected
      callIdRef.current = preConnectedCallId;
      setCallId(preConnectedCallId);
      setCallState(S.CONNECTED);
      setStatusMsg('Connected');
      startTimer();
    } else if (callState === S.IDLE) {
      _startCall();
    }
  }, [visible]);

  // ── Reset on close ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!visible) {
      stopTimer();
      setCallState(S.IDLE);
      setCallId(null);
      setDuration(0);
      setStatusMsg('');
      setErrorMsg('');
      setQuality('good');
      setIsMuted(false);
      setSignalInfo(null);
      callIdRef.current = null;
    }
  }, [visible]);

  // ── Place call ─────────────────────────────────────────────────────────────
  async function _startCall() {
    setCallState(S.CALLING);
    setStatusMsg(STATE_LABEL[S.CALLING]);

    const result = await CallServiceV2.initiateCall({
      recipientEmail,
      recipientName,
      callType,
      senderName:   currentUser?.name,
      senderAvatar: currentUser?.avatar,
    });

    if (!result.ok) {
      // Friendship gate blocked the call
      if (result.code === 'FRIENDSHIP_REQUIRED') {
        Alert.alert(
          'Not Friends',
          `You can only call users you\'re friends with. Send ${recipientName || recipientEmail} a friend request first.`,
          [{ text: 'OK', onPress: _doClose }]
        );
        return;
      }
      // COPPA block
      if (result.code === 'UNDER_13_NO_VPC') {
        Alert.alert(
          'Parental Approval Required',
          'Please complete the parental consent process before making calls.',
          [{ text: 'OK', onPress: _doClose }]
        );
        return;
      }
      setErrorMsg(result.error || 'Failed to start call');
      setCallState(S.ENDED);
      setTimeout(_doClose, 3000);
      return;
    }

    callIdRef.current = result.callId;
    setCallId(result.callId);
    setCallState(S.RINGING);
    setStatusMsg(`Calling ${recipientName || recipientEmail}...`);

    // Store preflight debug info
    if (result.preflight) {
      setSignalInfo({
        method:             result.preflight.signalMethod,
        friendshipVerified: result.preflight.friendshipVerified,
        fcmDelivered:       result.preflight.fcmDelivered,
      });
    }
  }

  // ── Controls ──────────────────────────────────────────────────────────────
  async function _hangUp() {
    stopTimer();
    setCallState(S.ENDING);
    await CallServiceV2.hangUp('hangup');
    setCallState(S.ENDED);
    setStatusMsg('Call ended');
    setTimeout(_doClose, 1200);
  }

  function _toggleMute() {
    setIsMuted(CallServiceV2.toggleMute());
  }

  function _toggleCamera() {
    setIsCamOff(CallServiceV2.toggleCamera());
  }

  function _doClose() {
    stopTimer();
    onClose?.();
  }

  const isConnected = callState === S.CONNECTED || callState === S.RECONNECTING;
  const isLive      = [S.RINGING, S.ACK, S.CONNECTING, S.CONNECTED, S.RECONNECTING].includes(callState);
  const qColor      = quality === 'poor' ? '#ef4444' : quality === 'degraded' ? '#f59e0b' : '#22c55e';

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent
      onRequestClose={() => isLive ? _hangUp() : _doClose()}
    >
      <StatusBar barStyle="light-content" backgroundColor="#0a0a0a" translucent />
      <Animated.View style={[styles.root, { opacity: fadeAnim }]}>

        {/* Top bar */}
        <View style={styles.topBar}>
          <View style={[styles.qualityDot, { backgroundColor: isConnected ? qColor : '#4b5563' }]} />
          <Text style={styles.callTypeLabel}>
            {callType === 'video' ? '📹 Video Call' : '📞 Voice Call'}
          </Text>
          {signalInfo?.friendshipVerified && (
            <View style={styles.friendBadge}>
              <Text style={styles.friendBadgeText}>🔐 Verified</Text>
            </View>
          )}
        </View>

        {/* Avatar */}
        <View style={styles.center}>
          <Avatar
            name={recipientName}
            uri={recipientAvatar}
            size={128}
            pulse={[S.RINGING, S.ACK].includes(callState) ? pulseAnim : null}
          />
          <Text style={styles.name} numberOfLines={1}>{recipientName || recipientEmail}</Text>
          <Text style={styles.email} numberOfLines={1}>{recipientEmail}</Text>

          {/* Status */}
          <Text style={[styles.status, {
            color: callState === S.ACK ? '#60a5fa' : '#9ca3af',
            fontWeight: callState === S.ACK ? '700' : '400',
          }]}>
            {errorMsg || statusMsg || STATE_LABEL[callState]}
          </Text>

          {/* Duration */}
          {isConnected && (
            <Text style={styles.duration}>{fmt(duration)}</Text>
          )}

          {/* Signal method badge */}
          {signalInfo && !isConnected && (
            <View style={styles.signalBadge}>
              <Text style={styles.signalBadgeText}>
                {signalInfo.fcmDelivered ? '📡 FCM wake sent' : '🔄 Polling fallback'}
              </Text>
            </View>
          )}
        </View>

        {/* Controls */}
        <View style={styles.controls}>
          {isConnected && (
            <>
              <CtrlBtn
                onPress={_toggleMute}
                bg={isMuted ? '#7f1d1d' : '#1f2937'}
                icon={isMuted ? '🔇' : '🎙️'}
                label={isMuted ? 'Unmute' : 'Mute'}
              />
              {callType === 'video' && (
                <CtrlBtn
                  onPress={_toggleCamera}
                  bg={isCamOff ? '#7f1d1d' : '#1f2937'}
                  icon={isCamOff ? '📷' : '📹'}
                  label={isCamOff ? 'Start camera' : 'Stop camera'}
                />
              )}
              <CtrlBtn
                onPress={() => CallServiceV2.toggleSpeaker?.()}
                bg="#1f2937"
                icon="🔊"
                label="Speaker"
              />
            </>
          )}

          {/* End call */}
          {isLive && (
            <CtrlBtn
              onPress={_hangUp}
              bg="#dc2626"
              icon="📵"
              label="End call"
            />
          )}

          {/* Close when ended */}
          {callState === S.ENDED && (
            <CtrlBtn onPress={_doClose} bg="#1f2937" icon="✕" label="Close" />
          )}
        </View>

      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root:          { flex: 1, backgroundColor: '#0a0a0a', justifyContent: 'space-between', paddingBottom: Platform.OS === 'ios' ? 48 : 32 },
  topBar:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: Platform.OS === 'ios' ? 60 : 40, gap: 8 },
  qualityDot:    { width: 8, height: 8, borderRadius: 4 },
  callTypeLabel: { color: '#9ca3af', fontSize: 13, fontWeight: '500', flex: 1 },
  friendBadge:   { backgroundColor: '#052e16', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: '#166534' },
  friendBadgeText: { color: '#4ade80', fontSize: 11, fontWeight: '700' },
  center:        { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 32 },
  avatarWrap:    { backgroundColor: '#4f46e5', alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  avatarText:    { color: '#fff', fontWeight: '800' },
  name:          { color: '#fff', fontSize: 28, fontWeight: '800', textAlign: 'center' },
  email:         { color: '#6b7280', fontSize: 14, textAlign: 'center' },
  status:        { fontSize: 15, textAlign: 'center', marginTop: 4 },
  duration:      { color: '#fff', fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'], marginTop: 4 },
  signalBadge:   { backgroundColor: '#1e3a5f', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, marginTop: 8, borderWidth: 1, borderColor: '#1d4ed8' },
  signalBadgeText: { color: '#93c5fd', fontSize: 12 },
  controls:      { flexDirection: 'row', justifyContent: 'center', gap: 20, paddingHorizontal: 32, paddingTop: 16 },
  ctrlBtn:       { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  ctrlIcon:      { fontSize: 26 },
});
