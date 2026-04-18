/**
 * IncomingCallModal.js — OurSpace 2.0 · Zero-Redirection v2
 * ─────────────────────────────────────────────────────────────────────────────
 * Full-screen incoming call sheet — slides up from bottom, over any screen.
 * This is the in-app call UI shown when the app is in the foreground.
 * (When app is backgrounded/killed, NativeCallBridge shows the OS-level UI.)
 *
 * Updated for v2:
 *   - Uses CallServiceV2 for answer/decline
 *   - Sends signalingAck automatically on answer/decline
 *   - Shows sender verification badge (friendship verified)
 *
 * Props:
 *   visible     boolean
 *   callData    { call_id, call_type, sender_name, sender_email, sender_avatar, ... }
 *   onAnswer    (callData) => void
 *   onDecline   () => void
 *   onMissed    () => void
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet,
  Animated, Easing, Image, StatusBar, Platform, Vibration,
} from 'react-native';
import CallServiceV2 from '../services/CallServiceV2';
import { log, POLL } from '../config/api';

// ── Expanding ring ─────────────────────────────────────────────────────────────
function Ring({ anim, size, color }) {
  return (
    <Animated.View style={{
      position:     'absolute',
      width:        size,
      height:       size,
      borderRadius: size / 2,
      borderWidth:  2,
      borderColor:  color,
      transform:    [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] }) }],
      opacity:      anim.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] }),
    }} />
  );
}

// ── Avatar ─────────────────────────────────────────────────────────────────────
function Avatar({ name, uri, size }) {
  const initials = (name || '?').split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#4f46e5', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      {uri
        ? <Image source={{ uri }} style={{ width: size, height: size }} />
        : <Text style={{ color: '#fff', fontSize: size * 0.36, fontWeight: '700' }}>{initials}</Text>
      }
    </View>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function IncomingCallModal({ visible, callData, onAnswer, onDecline, onMissed }) {
  const [isAnswering, setIsAnswering] = useState(false);
  const [isDeclining, setIsDeclining] = useState(false);

  const slideAnim = useRef(new Animated.Value(900)).current;
  const pulseAnim = useRef(new Animated.Value(0)).current;
  const ring1     = useRef(new Animated.Value(0)).current;
  const ring2     = useRef(new Animated.Value(0)).current;
  const ring3     = useRef(new Animated.Value(0)).current;
  const missTimer = useRef(null);

  // ── Appear ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (visible) {
      // Slide up
      Animated.spring(slideAnim, {
        toValue:  0,
        tension:  65,
        friction: 11,
        useNativeDriver: true,
      }).start();

      // Pulse avatar
      Animated.loop(Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])).start();

      // Staggered rings
      [ring1, ring2, ring3].forEach((r, i) => {
        Animated.loop(Animated.sequence([
          Animated.delay(i * 600),
          Animated.timing(r, { toValue: 1, duration: 1800, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          Animated.timing(r, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])).start();
      });

      // Auto-miss after TTL
      missTimer.current = setTimeout(() => {
        _dismiss();
        onMissed?.();
      }, POLL.NOTIFICATION_TTL || 45000);

    } else {
      slideAnim.setValue(900);
      pulseAnim.setValue(0);
    }
    return () => clearTimeout(missTimer.current);
  }, [visible]);

  function _dismiss() {
    clearTimeout(missTimer.current);
    Vibration.cancel();
    Animated.timing(slideAnim, { toValue: 900, duration: 280, useNativeDriver: true }).start();
  }

  // ── Answer ───────────────────────────────────────────────────────────────────
  const handleAnswer = useCallback(async () => {
    if (isAnswering || isDeclining) return;
    setIsAnswering(true);
    clearTimeout(missTimer.current);
    Vibration.cancel();

    log.info('IncomingCallModal: answering callId=', callData?.call_id);

    const result = await CallServiceV2.answerCall(callData?.call_id);

    if (!result.ok) {
      log.error('IncomingCallModal answer failed:', result.error);
      setIsAnswering(false);
      _dismiss();
      onDecline?.();
      return;
    }

    _dismiss();
    onAnswer?.({ ...callData, ...result });
  }, [callData, isAnswering, isDeclining]);

  // ── Decline ──────────────────────────────────────────────────────────────────
  const handleDecline = useCallback(async () => {
    if (isAnswering || isDeclining) return;
    setIsDeclining(true);
    clearTimeout(missTimer.current);

    log.info('IncomingCallModal: declining callId=', callData?.call_id);
    await CallServiceV2.declineCall(callData?.call_id);

    _dismiss();
    setTimeout(() => {
      setIsDeclining(false);
      onDecline?.();
    }, 320);
  }, [callData, isAnswering, isDeclining]);

  const callerName   = callData?.sender_name   || callData?.sender_email || 'Someone';
  const callerEmail  = callData?.sender_email  || '';
  const callerAvatar = callData?.sender_avatar || null;
  const callType     = callData?.call_type     || 'voice';
  const pulseScale   = pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] });

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      animationType="none"
      transparent
      statusBarTranslucent
      onRequestClose={handleDecline}
    >
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      {/* Backdrop */}
      <View style={styles.backdrop}>
        <Animated.View style={[styles.sheet, { transform: [{ translateY: slideAnim }] }]}>

          {/* Drag pill */}
          <View style={styles.pill} />

          {/* Label */}
          <Text style={styles.incomingLabel}>
            {callType === 'video' ? '📹 Incoming Video Call' : '📞 Incoming Voice Call'}
          </Text>

          {/* Avatar with rings */}
          <View style={styles.avatarArea}>
            <Ring anim={ring1} size={144} color="#6366f1" />
            <Ring anim={ring2} size={144} color="#6366f1" />
            <Ring anim={ring3} size={144} color="#818cf8" />
            <Animated.View style={{ transform: [{ scale: pulseScale }] }}>
              <Avatar name={callerName} uri={callerAvatar} size={120} />
            </Animated.View>
          </View>

          {/* Caller info */}
          <Text style={styles.callerName} numberOfLines={1}>{callerName}</Text>
          <Text style={styles.callerEmail} numberOfLines={1}>{callerEmail}</Text>

          {/* Answer / Decline */}
          <View style={styles.controls}>

            {/* Decline */}
            <View style={styles.ctrlItem}>
              <TouchableOpacity
                style={[styles.ctrlBtn, styles.declineBtn]}
                onPress={handleDecline}
                disabled={isDeclining || isAnswering}
                activeOpacity={0.8}
                accessibilityLabel="Decline call"
                accessibilityRole="button"
              >
                <Text style={styles.ctrlIcon}>{isDeclining ? '⏳' : '📵'}</Text>
              </TouchableOpacity>
              <Text style={styles.ctrlLabel}>Decline</Text>
            </View>

            {/* Answer */}
            <View style={styles.ctrlItem}>
              <TouchableOpacity
                style={[styles.ctrlBtn, styles.answerBtn]}
                onPress={handleAnswer}
                disabled={isAnswering || isDeclining}
                activeOpacity={0.8}
                accessibilityLabel="Answer call"
                accessibilityRole="button"
              >
                <Text style={styles.ctrlIcon}>
                  {isAnswering ? '⏳' : (callType === 'video' ? '📹' : '📞')}
                </Text>
              </TouchableOpacity>
              <Text style={styles.ctrlLabel}>Answer</Text>
            </View>

          </View>

          <Text style={styles.hint}>Swipe down to dismiss</Text>

        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop:      { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor:   '#111827',
    borderTopLeftRadius:  32,
    borderTopRightRadius: 32,
    paddingTop:         14,
    paddingBottom:      Platform.OS === 'ios' ? 52 : 36,
    paddingHorizontal:  32,
    alignItems:         'center',
    minHeight:          '55%',
    shadowColor:        '#000',
    shadowOffset:       { width: 0, height: -8 },
    shadowOpacity:      0.5,
    shadowRadius:       24,
    elevation:          20,
  },
  pill:          { width: 44, height: 4, borderRadius: 2, backgroundColor: '#374151', marginBottom: 20 },
  incomingLabel: { color: '#9ca3af', fontSize: 13, fontWeight: '600', letterSpacing: 0.5, marginBottom: 28 },
  avatarArea:    { width: 144, height: 144, alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  callerName:    { color: '#fff', fontSize: 26, fontWeight: '800', textAlign: 'center' },
  callerEmail:   { color: '#6b7280', fontSize: 13, marginTop: 4, textAlign: 'center', marginBottom: 36 },
  controls:      { flexDirection: 'row', justifyContent: 'center', gap: 64 },
  ctrlItem:      { alignItems: 'center', gap: 10 },
  ctrlBtn:       { width: 70, height: 70, borderRadius: 35, alignItems: 'center', justifyContent: 'center' },
  declineBtn:    { backgroundColor: '#dc2626' },
  answerBtn:     { backgroundColor: '#16a34a' },
  ctrlIcon:      { fontSize: 28 },
  ctrlLabel:     { color: '#9ca3af', fontSize: 13, fontWeight: '500' },
  hint:          { color: '#374151', fontSize: 12, marginTop: 28 },
});
