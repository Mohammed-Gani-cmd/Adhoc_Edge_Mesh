import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ViewStyle } from 'react-native';

export const colors = {
  background: '#080D14', surface: '#111B27', raised: '#172433', border: '#283A4D',
  text: '#F0F6FC', muted: '#A7B8CB', teal: '#5EEAD4', blue: '#93C5FD', amber: '#FCD34D', red: '#FDA4AF',
};
export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
const toneColor = { neutral: colors.muted, success: colors.teal, warning: colors.amber, danger: colors.red, info: colors.blue };

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  return <View style={[styles.badge, { borderColor: toneColor[tone] + '55', backgroundColor: toneColor[tone] + '10' }]}>
    <View style={[styles.dot, { backgroundColor: toneColor[tone] }]} /><Text style={[styles.badgeText, { color: toneColor[tone] }]}>{label}</Text>
  </View>;
}

export function ActionButton({ title, onPress, disabled, loading, secondary = false, compact = false }: {
  title: string; onPress: () => void; disabled?: boolean; loading?: boolean; secondary?: boolean; compact?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: !!disabled, busy: !!loading }}
    disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, secondary && styles.secondary, compact && styles.compact, (disabled || pressed) && { opacity: disabled ? 0.45 : 0.75 }]}>
    {loading && <ActivityIndicator size="small" color={secondary ? colors.teal : colors.background} />}
    <Text style={[styles.buttonText, secondary && { color: colors.text }]}>{title}</Text>
  </Pressable>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}
export function Metric({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return <View style={styles.metric}><Text style={[styles.metricValue, accent && { color: colors.teal }]}>{value}</Text><Text style={styles.metricLabel}>{label}</Text></View>;
}
export function Progress({ percent }: { percent: number }) {
  return <View accessibilityRole="progressbar" accessibilityLabel="Images completed" accessibilityValue={{ min: 0, max: 100, now: percent }} style={styles.track}>
    <View style={[styles.fill, { width: `${Math.min(100, Math.max(0, percent))}%` }]} />
  </View>;
}
export function SectionHeading({ eyebrow, title, aside }: { eyebrow: string; title: string; aside?: string }) {
  return <View style={styles.sectionHead}><View><Text style={styles.eyebrow}>{eyebrow}</Text><Text style={styles.sectionTitle}>{title}</Text></View>{aside && <Text style={styles.small}>{aside}</Text>}</View>;
}
export function Notice({ text, danger = false }: { text?: string; danger?: boolean }) {
  if (!text) return null;
  return <Text accessibilityLiveRegion="polite" style={[styles.notice, danger && { color: colors.red, borderColor: colors.red + '50' }]}>{text}</Text>;
}

export const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, paddingBottom: 38, gap: 16 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 4 },
  brandRow: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  brandMark: { width: 42, height: 42, borderRadius: 14, borderWidth: 1, borderColor: '#5EEAD455', backgroundColor: '#5EEAD412', alignItems: 'center', justifyContent: 'center' },
  brandLetters: { color: colors.teal, fontWeight: '800', fontSize: 15 },
  brand: { color: colors.text, fontSize: 21, fontWeight: '800', letterSpacing: -0.6 },
  small: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  eyebrow: { color: colors.teal, fontSize: 10, letterSpacing: 2, fontWeight: '700', marginBottom: 5 },
  headline: { color: colors.text, fontSize: 30, lineHeight: 36, letterSpacing: -1, fontWeight: '700' },
  subtitle: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 7 },
  card: { padding: 18, borderRadius: 22, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: 14 },
  hero: { borderColor: '#5EEAD450', backgroundColor: '#10242B' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  title: { color: colors.text, fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
  text: { color: colors.text, fontSize: 14, lineHeight: 21 },
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', marginBottom: 6 },
  input: { color: colors.text, backgroundColor: colors.background, borderRadius: 13, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 13, fontSize: 15, minHeight: 48 },
  badge: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, paddingVertical: 6, paddingHorizontal: 9, borderRadius: 20, borderWidth: 1, maxWidth: '100%' },
  dot: { height: 5, width: 5, borderRadius: 3 },
  badgeText: { fontSize: 10, fontWeight: '700', flexShrink: 1 },
  button: { minHeight: 50, borderRadius: 14, backgroundColor: colors.teal, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', paddingHorizontal: 18, paddingVertical: 13, gap: 9 },
  compact: { minHeight: 46, paddingHorizontal: 14, paddingVertical: 10 },
  secondary: { backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border },
  buttonText: { color: colors.background, fontSize: 14, fontWeight: '700', textAlign: 'center', flexShrink: 1 },
  metricRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  metric: { flex: 1, minWidth: 70, borderRadius: 14, backgroundColor: '#080D1460', padding: 11, gap: 3 },
  metricValue: { color: colors.text, fontSize: 23, fontWeight: '700', fontVariant: ['tabular-nums'] },
  metricLabel: { color: colors.muted, fontSize: 11, lineHeight: 16 },
  divider: { height: 1, backgroundColor: colors.border },
  sectionHead: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10, marginTop: 12 },
  sectionTitle: { color: colors.text, fontSize: 21, fontWeight: '700', letterSpacing: -0.6 },
  track: { height: 6, backgroundColor: colors.border, borderRadius: 4, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: colors.teal, borderRadius: 4 },
  notice: { color: colors.muted, fontSize: 12, lineHeight: 19, borderLeftWidth: 2, borderColor: colors.teal + '80', paddingLeft: 10 },
  taskBox: { backgroundColor: '#080D1480', borderRadius: 15, padding: 13, gap: 8 },
  filename: { color: colors.text, fontWeight: '600', fontSize: 14, lineHeight: 20, flexShrink: 1 },
  activity: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 8 },
  empty: { paddingVertical: 16, alignItems: 'center', gap: 6 },
  emptyTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  emptyText: { color: colors.muted, fontSize: 13, textAlign: 'center', lineHeight: 20 },
  link: { color: colors.blue, fontSize: 12, fontWeight: '600', paddingVertical: 10 },
  stages: { flexDirection: 'row', gap: 5 },
  segment: { flex: 1, height: 3, borderRadius: 2, backgroundColor: colors.border },
});
