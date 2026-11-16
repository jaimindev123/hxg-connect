import { StatusBar } from 'expo-status-bar';
import { ReactNode, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { api, Session, session } from './src/api';
import { flushQueue, pendingCount } from './src/queue';
import MyDay from './src/screens/MyDay';
import { LeadDetail, Leads } from './src/screens/Leads';
import CheckIn from './src/screens/CheckIn';

// Black and white, same as the web app: urgency is shown by weight and a black edge, not colour.
export const C = { ink: '#111111', ink2: '#555555', ink3: '#8A8A8A', paper: '#F5F5F5', surface: '#FFFFFF', line: '#DDDDDD',
  act: '#111111', actSoft: '#EBEBEB', brass: '#111111', brick: '#111111', brickSoft: '#EBEBEB', amberSoft: '#EBEBEB', amber: '#111111' };

export function Btn({ title, onPress, kind = 'plain', disabled, small }: { title: string; onPress: () => void; kind?: 'plain' | 'primary' | 'danger'; disabled?: boolean; small?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button"
      style={({ pressed }) => [s.btn, small && s.btnSm, kind === 'primary' && s.btnPrimary, kind === 'danger' && { borderColor: C.brick }, (pressed || disabled) && { opacity: 0.6 }]}>
      <Text style={[s.btnText, small && { fontSize: 13 }, kind === 'primary' && { color: '#fff' }, kind === 'danger' && { color: C.brick }]}>{title}</Text>
    </Pressable>
  );
}
export function Input(props: React.ComponentProps<typeof TextInput> & { label: string }) {
  return <View style={{ marginBottom: 12 }}><Text style={s.label}>{props.label}</Text>
    <TextInput placeholderTextColor={C.ink3} {...props} style={[s.input, props.multiline && { height: 80, textAlignVertical: 'top' }, props.style]} /></View>;
}
export const Header = ({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) => (
  <View style={s.header}><View style={{ flex: 1 }}><Text style={s.h1}>{title}</Text>{sub ? <Text style={s.sub}>{sub}</Text> : null}</View>{right}</View>
);

function Login({ onDone }: { onDone: (s: Session) => void }) {
  const [server, setServer] = useState('https://');
  const [workspace, setWorkspace] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    setError('');
    const srv = server.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/.test(srv)) return setError('Enter the server address your admin gave you, starting with https://');
    setBusy(true);
    try {
      const ws = workspace.trim().toLowerCase();
      const r = await api('POST', '/auth/login', { email: email.trim(), password }, { server: srv, workspace: ws });
      const sess = { server: srv, workspace: ws, token: r.token, name: r.user.name, role: r.user.role, userId: r.user.id };
      await session.save(sess);
      onDone(sess);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.paper }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
        <Image source={require('./assets/hxg-logo.png')} style={{ width: 240, height: 90, marginBottom: 8 }} resizeMode="contain" accessibilityLabel="HXG Connect" />
        <Text style={[s.h1, { fontSize: 24 }]}>HXG Connect</Text>
        <Text style={[s.sub, { marginBottom: 24 }]}>Sign in to your company's workspace.</Text>
        {error ? <Text style={s.error}>{error}</Text> : null}
        <Input label="Server address" value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
        <Input label="Workspace" value={workspace} onChangeText={setWorkspace} autoCapitalize="none" autoCorrect={false} placeholder="sunrise" />
        <Input label="Work email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
        <Input label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" />
        <Btn title={busy ? 'Signing in…' : 'Sign in'} kind="primary" onPress={submit} disabled={busy || !workspace || !email || !password} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

type Tab = 'day' | 'leads' | 'checkin';

function Main({ onSignOut }: { onSignOut: () => void }) {
  const [tab, setTab] = useState<Tab>('day');
  const [lead, setLead] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const refreshQueue = useCallback(() => { flushQueue().catch(() => 0).then(() => pendingCount()).then(setPending); }, []);

  useEffect(() => {
    refreshQueue();
    const sub = AppState.addEventListener('change', st => { if (st === 'active') refreshQueue(); });
    const t = setInterval(refreshQueue, 60_000);
    return () => { sub.remove(); clearInterval(t); };
  }, [refreshQueue]);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { if (lead) { setLead(null); return true; } return false; });
    return () => sub.remove();
  }, [lead]);

  // Unsent check-ins stay on the phone under this person and send the next
  // time they sign in here, never under whoever signs in next.
  function signOut() {
    if (!pending) return onSignOut();
    Alert.alert('Check-ins not sent yet',
      `${pending} check-in${pending === 1 ? ' is' : 's are'} still on this phone. ${pending === 1 ? 'It' : 'They'} will send the next time you sign in here, never under anyone else's name.`,
      [{ text: 'Stay signed in', style: 'cancel' }, { text: 'Sign out', style: 'destructive', onPress: onSignOut }]);
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.paper }} edges={['top', 'bottom']}>
      <StatusBar style="dark" />
      {pending > 0 && <View style={s.banner}><Text style={{ color: C.amber, fontWeight: '600' }}>{pending} check-in{pending === 1 ? '' : 's'} waiting for signal. They'll send automatically.</Text></View>}
      <View style={{ flex: 1 }}>
        {lead ? <LeadDetail id={lead} onBack={() => setLead(null)} />
          : tab === 'day' ? <MyDay onOpenLead={setLead} />
          : tab === 'leads' ? <Leads onOpenLead={setLead} />
          : <CheckIn onSaved={refreshQueue} />}
      </View>
      <View style={s.tabs} accessibilityRole="tablist">
        {([['day', 'My day'], ['leads', 'Leads'], ['checkin', 'Check in']] as const).map(([k, l]) => (
          <Pressable key={k} style={s.tab} onPress={() => { setLead(null); setTab(k); }} accessibilityRole="tab" accessibilityState={{ selected: tab === k }}>
            <Text style={[s.tabText, tab === k && !lead && { color: C.act, fontWeight: '700' }]}>{l}</Text>
          </Pressable>))}
        <Pressable style={s.tab} onPress={signOut} accessibilityRole="button"><Text style={s.tabText}>Sign out</Text></Pressable>
      </View>
    </SafeAreaView>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Session | null>(null);
  useEffect(() => { session.onSignedOut(() => setMe(null)); session.load().then(x => { setMe(x); setReady(true); }); }, []);
  return (
    <SafeAreaProvider>
      {!ready ? <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator color={C.act} /></View>
        : me ? <Main onSignOut={() => { session.clear(); setMe(null); }} /> : <Login onDone={setMe} />}
    </SafeAreaProvider>
  );
}

export const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 18, paddingTop: 14, paddingBottom: 10 },
  h1: { fontSize: 22, fontWeight: '700', color: C.ink },
  sub: { color: C.ink2, marginTop: 2 },
  label: { fontSize: 13, color: C.ink2, marginBottom: 4, fontWeight: '500' },
  input: { borderWidth: 1, borderColor: '#C4C4C4', borderRadius: 6, paddingHorizontal: 12, height: 44, backgroundColor: C.surface, color: C.ink, fontSize: 15 },
  btn: { borderWidth: 1, borderColor: '#C4C4C4', borderRadius: 6, height: 44, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface },
  btnSm: { height: 34, paddingHorizontal: 12 },
  btnPrimary: { backgroundColor: C.act, borderColor: C.act },
  btnText: { fontWeight: '600', color: C.ink, fontSize: 15 },
  error: { backgroundColor: C.brickSoft, color: C.brick, padding: 10, borderRadius: 6, marginBottom: 12 },
  card: { backgroundColor: C.surface, borderBottomWidth: 1, borderColor: C.line, padding: 14 },
  urgent: { borderLeftWidth: 3, borderLeftColor: C.brick },
  banner: { backgroundColor: C.amberSoft, paddingHorizontal: 16, paddingVertical: 8 },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderColor: C.line, backgroundColor: C.surface },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  tabText: { color: C.ink2, fontSize: 13 },
  chip: { borderWidth: 1, borderColor: '#C4C4C4', borderRadius: 99, paddingHorizontal: 12, paddingVertical: 6, marginRight: 6, marginBottom: 6 },
  chipOn: { backgroundColor: C.act, borderColor: C.act },
});
