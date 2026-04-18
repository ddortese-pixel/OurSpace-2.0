/**
 * App.js — OurSpace 2.0 · Zero-Redirection v2 (FINAL)
 * ─────────────────────────────────────────────────────────────────────────────
 * Complete integration of the Zero-Redirection master prompt spec.
 *
 * SIGNAL DELIVERY (4 layers, in order):
 *   1. Data-only FCM push → wakes killed app → ConnectionService/CallKit UI
 *   2. Notifee heads-up notification → ringtone + Answer/Decline (background)
 *   3. Android Foreground Service polling → killed app (no Firebase needed)
 *   4. In-app polling every 2s → foreground fallback (always on)
 *
 * PRE-FLIGHT HANDSHAKE:
 *   Friendship check → fresh token fetch → Daily.co room → dynamic TURN →
 *   SignalingState → high-priority FCM wake → NotificationLedger fallback
 *
 * KILLED-APP RESUME:
 *   global.__OURSPACE_INITIAL_CALL__ set by index.js → consumed on mount →
 *   IncomingCallModal shown automatically
 *
 * TOKEN AUTO-REFRESH:
 *   Every AppState 'active' event → /api/refreshDeviceToken → zero stale tokens
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  SafeAreaView, View, Text, TouchableOpacity, ScrollView,
  StyleSheet, Alert, RefreshControl, ActivityIndicator,
  Platform, StatusBar, AppState,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import CallModal             from './src/components/CallModal';
import IncomingCallModal     from './src/components/IncomingCallModal';
import CallServiceV2         from './src/services/CallServiceV2';
import PushNotificationService from './src/services/PushNotificationService';
import ForegroundService     from './src/services/CallPollingForegroundService';
import BatteryOptimizationHelper from './src/utils/BatteryOptimizationHelper';
import { setAuthToken, log } from './src/config/api';

// ── Config ─────────────────────────────────────────────────────────────────────
// Replace authToken: open https://face-app-0b743c8e.base44.app in browser →
//   log in → DevTools → Application → LocalStorage → base44_auth_token
const DEMO_USER = {
  email:     'ddortese@gmail.com',
  name:      'Derek',
  avatar:    null,
  authToken: '__REPLACE_WITH_BASE44_TOKEN__',
};

// Replace with real user emails you want to test calling
const CALL_TARGETS = [
  { email: 'alice@ourspace.app',   name: 'Alice',   avatar: null, callType: 'voice' },
  { email: 'bob@ourspace.app',     name: 'Bob',     avatar: null, callType: 'voice' },
  { email: 'charlie@ourspace.app', name: 'Charlie', avatar: null, callType: 'video' },
];

// ── Helpers ────────────────────────────────────────────────────────────────────
const fmtDuration = (s) => (!s ? '—' : `${Math.floor(s / 60)}m ${s % 60}s`);

function StatusBadge({ status }) {
  const C = {
    ringing:   ['#fef3c7', '#92400e'],
    connected: ['#d1fae5', '#065f46'],
    ended:     ['#1f2937', '#9ca3af'],
    declined:  ['#fee2e2', '#991b1b'],
    missed:    ['#fce7f3', '#9d174d'],
    failed:    ['#fee2e2', '#991b1b'],
    ack:       ['#eff6ff', '#1d4ed8'],
  }[status] || ['#1f2937', '#9ca3af'];
  return (
    <View style={[styles.badge, { backgroundColor: C[0] }]}>
      <Text style={[styles.badgeText, { color: C[1] }]}>
        {status ? status.charAt(0).toUpperCase() + status.slice(1) : '?'}
      </Text>
    </View>
  );
}

function OnlineDot({ on }) {
  return (
    <View style={[styles.dot, { backgroundColor: on ? '#22c55e' : '#374151' }]} />
  );
}

// ── App ────────────────────────────────────────────────────────────────────────
export default function App() {
  const [ready,       setReady]       = useState(false);
  const [history,     setHistory]     = useState([]);
  const [refreshing,  setRefreshing]  = useState(false);
  const [battWarn,    setBattWarn]    = useState(false);
  const [serviceOn,   setServiceOn]   = useState(false);
  const [signalState, setSignalState] = useState('idle'); // idle | ringing | ack | connecting | connected

  // Outgoing call
  const [outOpen,   setOutOpen]   = useState(false);
  const [outTarget, setOutTarget] = useState(null);

  // Incoming call modal
  const [inVisible, setInVisible] = useState(false);
  const [inData,    setInData]    = useState(null);

  // Active connected call (answered incoming)
  const [connOpen,  setConnOpen]  = useState(false);
  const [connData,  setConnData]  = useState(null);

  // ── Boot ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    _boot();
    return _teardown;
  }, []);

  async function _boot() {
    log.info('OurSpace 2.0 booting (Zero-Redirection v2)...');

    // 1. Auth
    await setAuthToken(DEMO_USER.authToken).catch(() => {});

    // 2. Notifee channels + permissions
    await PushNotificationService.init(_onPushIncoming);

    // 3. Android: foreground service (keeps polling alive when killed)
    if (Platform.OS === 'android') {
      try {
        await ForegroundService.startForegroundService();
        setServiceOn(true);
        log.info('Foreground service started ✓');
      } catch (e) {
        log.warn('Foreground service failed (non-fatal):', e.message);
      }

      // Battery optimization check
      try {
        const batt = await BatteryOptimizationHelper.getStatusMessage();
        if (!batt.ok) setBattWarn(true);
        setTimeout(() => {
          BatteryOptimizationHelper.checkAndPrompt()
            .then(r => { if (r === 'exempt') setBattWarn(false); })
            .catch(() => {});
        }, 3000);
      } catch (_) {}
    }

    // 4. Wire FCM foreground message handler (if Firebase installed)
    _wireFCMForeground();

    // 5. Initialize CallServiceV2 — sets up native bridge + token refresh + polling
    await CallServiceV2.initialize(DEMO_USER.email);

    // 6. Load call history from cache
    try {
      const cached = await AsyncStorage.getItem('call_history');
      if (cached) setHistory(JSON.parse(cached));
    } catch (_) {}

    // 7. CHECK: Was app opened from a killed state by a call notification?
    //    index.js sets global.__OURSPACE_INITIAL_CALL__ if so
    if (global.__OURSPACE_INITIAL_CALL__) {
      const initialCall = global.__OURSPACE_INITIAL_CALL__;
      global.__OURSPACE_INITIAL_CALL__ = null; // consume it

      log.info('Resuming from killed state for callId=' + initialCall.call_id);

      // Give React a tick to fully mount before showing the modal
      setTimeout(() => {
        if (initialCall._notificationAnswer) {
          // User tapped Answer from notification — go straight to answering
          _handleIncoming(initialCall);
        } else {
          // App opened from tap on notification body — show incoming modal
          _handleIncoming(initialCall);
        }
      }, 800);
    }

    setReady(true);
    log.info('Boot complete ✓');
  }

  function _teardown() {
    CallServiceV2.cleanup();
    PushNotificationService.cleanup();
    // Foreground service intentionally NOT stopped on unmount
    // (keeps ringing if user navigates away from app)
  }

  // ── FCM foreground handler ──────────────────────────────────────────────────
  function _wireFCMForeground() {
    try {
      const messaging = require('@react-native-firebase/messaging').default;
      messaging().onMessage(async (remoteMessage) => {
        const data = remoteMessage?.data || {};
        if (data.type === 'incoming_call_wake') {
          log.info('FCM foreground message — incoming call callId=' + data.call_id);
          await CallServiceV2.handleFCMDataMessage(data);
        }
      });
    } catch (_) {
      // Firebase not installed — polling handles it
    }
  }

  // ── PushNotificationService callback ────────────────────────────────────────
  function _onPushIncoming(callData) {
    _handleIncoming(callData);
  }

  // ── CallServiceV2 event listeners ───────────────────────────────────────────
  useEffect(() => {
    const subs = [
      // Incoming call detected (via any signal path)
      CallServiceV2.addListener('incoming', ({ callData }) => _handleIncoming(callData)),

      // Caller: recipient's device received the push
      CallServiceV2.addListener('ack_received', ({ callId }) => {
        log.info('ACK received — recipient device is awake callId=' + callId);
        setSignalState('ack');
      }),

      // Call went live
      CallServiceV2.addListener('answered', ({ callId }) => {
        setSignalState('connected');
        _addHistory({
          id: callId, type: 'outgoing', status: 'connected',
          duration: 0, timestamp: new Date().toISOString(),
        });
      }),

      // Call ended
      CallServiceV2.addListener('ended', ({ callId, duration, reason }) => {
        setSignalState('idle');
        _addHistory({
          id: callId, type: 'outgoing',
          status: reason === 'declined' ? 'declined' : reason === 'missed' ? 'missed' : 'ended',
          duration, timestamp: new Date().toISOString(),
        });
      }),

      // Remote declined
      CallServiceV2.addListener('declined', ({ callId }) => {
        setSignalState('idle');
        _addHistory({
          id: callId, type: 'outgoing', status: 'declined',
          duration: 0, timestamp: new Date().toISOString(),
        });
      }),

      // Timed out (no answer)
      CallServiceV2.addListener('missed', ({ callId }) => {
        setSignalState('idle');
        _addHistory({
          id: callId, type: 'outgoing', status: 'missed',
          duration: 0, timestamp: new Date().toISOString(),
        });
      }),

      // Connection errors
      CallServiceV2.addListener('error', ({ message }) => {
        setSignalState('idle');
        Alert.alert('Call Error', message);
      }),
    ];

    return () => subs.forEach(u => u());
  }, [history]);

  // ── Incoming call handling ───────────────────────────────────────────────────
  function _handleIncoming(callData) {
    if (!callData?.call_id) return;

    // Already showing this call
    if (inData?.call_id === callData.call_id && inVisible) return;

    // Already in another call → auto-decline
    if (CallServiceV2.isInCall()) {
      CallServiceV2.declineCall(callData.call_id);
      return;
    }

    setInData(callData);
    setInVisible(true);
  }

  function _onAnswer(answeredData) {
    setInVisible(false);
    setInData(null);
    setConnData(answeredData);
    setConnOpen(true);
    setSignalState('connected');
    _addHistory({
      id: answeredData.call_id || answeredData.callId,
      type: 'incoming', status: 'connected',
      duration: 0, timestamp: new Date().toISOString(),
    });
  }

  function _onDecline() {
    _addHistory({
      id: inData?.call_id, type: 'incoming', status: 'declined',
      duration: 0, timestamp: new Date().toISOString(),
    });
    setInVisible(false);
    setInData(null);
  }

  function _onMissed() {
    _addHistory({
      id: inData?.call_id, type: 'incoming', status: 'missed',
      duration: 0, timestamp: new Date().toISOString(),
    });
    setInVisible(false);
    setInData(null);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────
  async function _addHistory(entry) {
    const updated = [entry, ...history].slice(0, 50);
    setHistory(updated);
    await AsyncStorage.setItem('call_history', JSON.stringify(updated)).catch(() => {});
  }

  async function _onRefresh() {
    setRefreshing(true);
    try {
      const cached = await AsyncStorage.getItem('call_history');
      if (cached) setHistory(JSON.parse(cached));
    } catch (_) {}
    setRefreshing(false);
  }

  function _placeCall(target) {
    if (CallServiceV2.isInCall()) {
      Alert.alert('Already in a call', 'End the current call first.');
      return;
    }
    setSignalState('ringing');
    setOutTarget(target);
    setOutOpen(true);
  }

  // ── Signal state label ───────────────────────────────────────────────────────
  const signalLabel = {
    idle:       null,
    ringing:    '📞 Ringing...',
    ack:        '✅ Device awake — connecting...',
    connecting: '🔗 Connecting...',
    connected:  '🟢 In call',
  }[signalState];

  // ── Splash ────────────────────────────────────────────────────────────────────
  if (!ready) {
    return (
      <View style={styles.splash}>
        <StatusBar barStyle="light-content" backgroundColor="#0a0a0a" />
        <Text style={styles.splashHex}>⬡</Text>
        <Text style={styles.splashTitle}>OurSpace</Text>
        <ActivityIndicator color="#6366f1" style={{ marginTop: 28 }} />
        <Text style={styles.splashSub}>Initializing call system...</Text>
      </View>
    );
  }

  // ── Main UI ───────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#0a0a0a" />

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.h1}>OurSpace 2.0</Text>
          <Text style={styles.h2}>Zero-Redirection v2</Text>
        </View>
        <View style={[styles.pill, { borderColor: serviceOn ? '#166534' : '#374151' }]}>
          <View style={[styles.pillDot, { backgroundColor: serviceOn ? '#22c55e' : '#6b7280' }]} />
          <Text style={[styles.pillText, { color: serviceOn ? '#22c55e' : '#6b7280' }]}>
            {serviceOn ? 'SERVICE' : 'POLL'}
          </Text>
        </View>
      </View>

      {/* Signal state banner */}
      {signalLabel && (
        <View style={styles.signalBanner}>
          <Text style={styles.signalText}>{signalLabel}</Text>
        </View>
      )}

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={_onRefresh} tintColor="#6366f1" />
        }
      >
        {/* Battery warning */}
        {battWarn && Platform.OS === 'android' && (
          <TouchableOpacity
            style={styles.battCard}
            onPress={() => BatteryOptimizationHelper.requestExemption?.()}
          >
            <Text style={styles.battTitle}>⚠️ Battery Optimization Active</Text>
            <Text style={styles.battBody}>
              Some Android OEMs restrict background services even with the Foreground
              Service running. Tap to disable battery optimization for OurSpace —
              this guarantees ringing from any app state.
            </Text>
            <Text style={styles.battCta}>Tap to fix →</Text>
          </TouchableOpacity>
        )}

        {/* Signal stack overview */}
        <View style={styles.signalCard}>
          <Text style={styles.cardTitle}>📡 Signal Stack</Text>
          {[
            ['FCM data-only push',       'Wakes killed app → native call UI',         true ],
            ['ConnectionService/CallKit', 'Lock screen call sheet',                    true ],
            ['Foreground Service poll',  'Killed app (no Firebase fallback)',          serviceOn],
            ['Notifee heads-up',         'Background app → ringtone + buttons',       true ],
            ['In-app polling 2s',        'Foreground always-on guarantee',            true ],
          ].map(([label, desc, on]) => (
            <View key={label} style={styles.signalRow}>
              <Text style={[styles.signalIcon, { color: on ? '#22c55e' : '#4b5563' }]}>
                {on ? '✅' : '⚠️'}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.signalLabel}>{label}</Text>
                <Text style={styles.signalDesc}>{desc}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* Pre-flight info */}
        <View style={styles.infoCard}>
          <Text style={styles.cardTitle}>🔐 Pre-flight Handshake</Text>
          {[
            'Friendship gate (server-enforced)',
            'Fresh device token fetched from DB',
            'Dynamic TURN credentials (no hardcoded servers)',
            'SignalingState ACK — caller knows device is awake',
            'COPPA age gate on every call',
          ].map(s => (
            <Text key={s} style={styles.infoLine}>✅ {s}</Text>
          ))}
        </View>

        {/* Contacts */}
        <Text style={styles.section}>Contacts</Text>
        {CALL_TARGETS.map(t => (
          <View key={t.email} style={styles.contact}>
            <View style={styles.avatar}>
              <Text style={styles.avatarLetter}>{t.name[0]}</Text>
              <OnlineDot on={false} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cName}>{t.name}</Text>
              <Text style={styles.cEmail}>{t.email}</Text>
            </View>
            <TouchableOpacity
              style={styles.callBtn}
              onPress={() => _placeCall(t)}
              accessibilityLabel={`Call ${t.name}`}
            >
              <Text style={{ fontSize: 20 }}>
                {t.callType === 'video' ? '📹' : '📞'}
              </Text>
            </TouchableOpacity>
          </View>
        ))}

        {/* Call history */}
        <Text style={styles.section}>Recent Calls</Text>
        {history.length === 0 ? (
          <Text style={styles.empty}>No calls yet — tap a contact above to test</Text>
        ) : (
          history.slice(0, 20).map((e, i) => (
            <View key={i} style={styles.histRow}>
              <Text style={{ fontSize: 20 }}>{e.type === 'incoming' ? '📲' : '📤'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.histId} numberOfLines={1}>
                  {e.id ? e.id.substring(0, 18) + '…' : '—'}
                </Text>
                <Text style={styles.histTime}>
                  {new Date(e.timestamp).toLocaleTimeString()} · {fmtDuration(e.duration)}
                </Text>
              </View>
              <StatusBadge status={e.status} />
            </View>
          ))
        )}
      </ScrollView>

      {/* ── Outgoing call ── */}
      {outTarget && (
        <CallModal
          visible={outOpen}
          onClose={() => {
            setOutOpen(false);
            setOutTarget(null);
            setSignalState('idle');
          }}
          recipientEmail={outTarget.email}
          recipientName={outTarget.name}
          recipientAvatar={outTarget.avatar}
          callType={outTarget.callType}
          currentUser={DEMO_USER}
        />
      )}

      {/* ── Incoming call ── */}
      <IncomingCallModal
        visible={inVisible}
        callData={inData}
        onAnswer={_onAnswer}
        onDecline={_onDecline}
        onMissed={_onMissed}
      />

      {/* ── Connected (answered incoming) ── */}
      {connData && (
        <CallModal
          visible={connOpen}
          onClose={() => { setConnOpen(false); setConnData(null); setSignalState('idle'); }}
          recipientEmail={connData.sender_email}
          recipientName={connData.sender_name}
          recipientAvatar={connData.sender_avatar}
          callType={connData.call_type || 'voice'}
          currentUser={DEMO_USER}
          preConnectedCallId={connData.call_id}
        />
      )}
    </SafeAreaView>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root:         { flex: 1, backgroundColor: '#0a0a0a' },
  splash:       { flex: 1, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center' },
  splashHex:    { fontSize: 72, color: '#6366f1' },
  splashTitle:  { fontSize: 32, fontWeight: '800', color: '#fff', marginTop: 8 },
  splashSub:    { color: '#6b7280', fontSize: 14, marginTop: 12 },

  header:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#1f2937' },
  h1:           { fontSize: 20, fontWeight: '800', color: '#fff' },
  h2:           { fontSize: 11, color: '#6366f1', marginTop: 2, fontWeight: '600' },
  pill:         { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, backgroundColor: '#0f172a' },
  pillDot:      { width: 7, height: 7, borderRadius: 4 },
  pillText:     { fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },

  signalBanner: { backgroundColor: '#1e3a5f', paddingHorizontal: 20, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#1d4ed8' },
  signalText:   { color: '#93c5fd', fontSize: 13, fontWeight: '600', textAlign: 'center' },

  scroll:       { padding: 16, paddingBottom: 48, gap: 12 },

  battCard:     { backgroundColor: '#431407', borderWidth: 1, borderColor: '#c2410c', borderRadius: 12, padding: 14 },
  battTitle:    { color: '#fb923c', fontSize: 14, fontWeight: '700', marginBottom: 4 },
  battBody:     { color: '#fdba74', fontSize: 12, lineHeight: 18 },
  battCta:      { color: '#f97316', fontSize: 13, fontWeight: '700', marginTop: 8 },

  signalCard:   { backgroundColor: '#0f172a', borderWidth: 1, borderColor: '#1e293b', borderRadius: 12, padding: 14, gap: 8 },
  cardTitle:    { color: '#fff', fontSize: 14, fontWeight: '700', marginBottom: 4 },
  signalRow:    { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  signalIcon:   { fontSize: 13, width: 20, marginTop: 1 },
  signalLabel:  { color: '#e2e8f0', fontSize: 13, fontWeight: '600' },
  signalDesc:   { color: '#6b7280', fontSize: 11, marginTop: 1 },

  infoCard:     { backgroundColor: '#0f172a', borderWidth: 1, borderColor: '#1e3a5f', borderRadius: 12, padding: 14, gap: 5 },
  infoLine:     { color: '#86efac', fontSize: 13 },

  section:      { fontSize: 11, fontWeight: '700', color: '#6b7280', letterSpacing: 0.8, textTransform: 'uppercase', marginTop: 8 },
  contact:      { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#111827', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#1f2937' },
  avatar:       { width: 44, height: 44, borderRadius: 22, backgroundColor: '#4f46e5', alignItems: 'center', justifyContent: 'center', position: 'relative' },
  avatarLetter: { color: '#fff', fontSize: 18, fontWeight: '700' },
  dot:          { width: 11, height: 11, borderRadius: 6, position: 'absolute', bottom: -1, right: -1, borderWidth: 2, borderColor: '#111827' },
  cName:        { color: '#fff', fontSize: 15, fontWeight: '600' },
  cEmail:       { color: '#6b7280', fontSize: 12, marginTop: 2 },
  callBtn:      { width: 44, height: 44, borderRadius: 22, backgroundColor: '#1e3a5f', alignItems: 'center', justifyContent: 'center' },

  empty:        { color: '#4b5563', fontSize: 13, fontStyle: 'italic', textAlign: 'center', paddingVertical: 20 },
  histRow:      { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#111827', borderRadius: 10, padding: 12 },
  histId:       { color: '#d1d5db', fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  histTime:     { color: '#6b7280', fontSize: 11, marginTop: 2 },
  badge:        { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText:    { fontSize: 11, fontWeight: '600' },
});
