import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, RefreshControl, Text, View } from 'react-native';
import { api } from '../api';
import { Btn, C, Header, Input, s } from '../../App';
import { humanize, useDialer, whatsapp, when } from '../dial';

const NEXT = [['call', 'Call'], ['whatsapp', 'WhatsApp'], ['meeting', 'Meeting'], ['site_visit', 'Site visit']] as const;
const WHEN = [['In 2 hours', 2], ['Tomorrow 11 am', -1], ['In 3 days', 72]] as const;
const dueFrom = (h: number) => { const d = new Date(); if (h === -1) { d.setDate(d.getDate() + 1); d.setHours(11, 0, 0, 0); } else d.setTime(d.getTime() + h * 3600e3); return d.toISOString(); };

export default function MyDay({ onOpenLead }: { onOpenLead: (id: string) => void }) {
  const [items, setItems] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState<any>(null);
  const dialer = useDialer();
  const load = useCallback(async () => {
    setBusy(true);
    try { setItems(await api('GET', '/follow-ups/my-day')); setError(''); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const overdue = items?.filter(i => i.overdue).length ?? 0;
  return (
    <View style={{ flex: 1 }}>
      <Header title="My day" sub={items ? `${overdue} overdue, ${items.length - overdue} still to do` : ' '} />
      {error ? <Text style={[s.error, { marginHorizontal: 16 }]}>{error}</Text> : null}
      <FlatList data={items ?? []} keyExtractor={i => i.id} refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}
        ListEmptyComponent={items ? <Text style={{ textAlign: 'center', color: C.ink2, marginTop: 40 }}>You're clear for today.</Text> : null}
        renderItem={({ item: f }) => (
          <View style={[s.card, f.overdue && s.urgent]}>
            <Pressable onPress={() => onOpenLead(f.lead_id)}>
              <Text style={{ fontWeight: '700', color: f.overdue ? C.brick : C.ink }}>{f.overdue ? `Overdue, ${when(f.due_at)}` : when(f.due_at)}</Text>
              <Text style={{ fontSize: 16, marginTop: 2 }}>{humanize(f.type)} {f.lead_name}</Text>
              <Text style={{ color: C.ink2 }}>{f.stage}{f.note ? `, ${f.note}` : ''}</Text>
            </Pressable>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
              <Btn small title="Call" kind="primary" onPress={() => dialer.call(f.lead_id, f.primary_phone)} />
              <Btn small title="WhatsApp" onPress={() => whatsapp(f.primary_phone)} />
              <Btn small title="Done" onPress={() => setClosing(f)} />
            </View>
          </View>)} />
      {dialer.modal}
      {closing && <Complete item={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); load(); }} />}
    </View>
  );
}

/** Same rule as the web app: closing a follow-up needs the next step. */
function Complete({ item, onClose, onDone }: { item: any; onClose: () => void; onDone: () => void }) {
  const [outcome, setOutcome] = useState('');
  const [type, setType] = useState<string>('call');
  const [h, setH] = useState<number>(-1);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api('POST', `/follow-ups/${item.id}/complete`, { outcome, next: { type, due_at: dueFrom(h) } }); onDone(); }
    catch (e: any) { Alert.alert('Not saved', e.message); } finally { setBusy(false); }
  }
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,.5)' }}>
        <View style={{ backgroundColor: C.surface, borderTopLeftRadius: 12, borderTopRightRadius: 12, padding: 18 }}>
          <Text style={{ fontSize: 17, fontWeight: '700', marginBottom: 10 }}>{humanize(item.type)} with {item.lead_name}</Text>
          <Input label="What happened?" value={outcome} onChangeText={setOutcome} multiline placeholder="Wants a corner unit, visiting Saturday" />
          <Text style={s.label}>Next step</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 6 }}>{NEXT.map(([k, l]) => (
            <Pressable key={k} style={[s.chip, type === k && s.chipOn]} onPress={() => setType(k)}><Text style={{ color: type === k ? '#fff' : C.ink }}>{l}</Text></Pressable>))}</View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12 }}>{WHEN.map(([l, v]) => (
            <Pressable key={l} style={[s.chip, h === v && s.chipOn]} onPress={() => setH(v)}><Text style={{ color: h === v ? '#fff' : C.ink }}>{l}</Text></Pressable>))}</View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}><Btn title="Cancel" onPress={onClose} /></View>
            <View style={{ flex: 1 }}><Btn title={busy ? 'Saving…' : 'Complete'} kind="primary" disabled={busy || outcome.trim().length < 2} onPress={save} /></View>
          </View>
        </View>
      </View>
    </Modal>
  );
}
