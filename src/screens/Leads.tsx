import { useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { api } from '../api';
import { Btn, C, Header, s } from '../../App';
import { useDialer, whatsapp, when } from '../dial';

const lakh = (v?: number | string | null) => (v ? (Number(v) >= 1e7 ? `₹${+(Number(v) / 1e7).toFixed(2)} Cr` : `₹${+(Number(v) / 1e5).toFixed(2)} L`) : '');

export function Leads({ onOpenLead }: { onOpenLead: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const t = setTimeout(() => api('GET', `/leads?limit=40${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`)
      .then(r => { setRows(r.data); setError(''); }).catch(e => setError(e.message)), 300);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <View style={{ flex: 1 }}>
      <Header title="Leads" />
      <TextInput style={[s.input, { marginHorizontal: 16, marginBottom: 8 }]} placeholder="Search name or phone" placeholderTextColor={C.ink3} value={q} onChangeText={setQ} />
      {error ? <Text style={[s.error, { marginHorizontal: 16 }]}>{error}</Text> : null}
      <FlatList data={rows ?? []} keyExtractor={r => r.id}
        ListEmptyComponent={rows ? <Text style={{ textAlign: 'center', color: C.ink2, marginTop: 40 }}>No leads match.</Text> : null}
        renderItem={({ item: l }) => (
          <Pressable style={s.card} onPress={() => onOpenLead(l.id)}>
            <Text style={{ fontSize: 16, fontWeight: '600' }}>{l.name}</Text>
            <Text style={{ color: C.ink2 }}>{l.stage}{l.budget_max ? `, ${lakh(l.budget_max)}` : ''}, {when(l.last_activity_at)}</Text>
          </Pressable>)} />
    </View>
  );
}

export function LeadDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [l, setL] = useState<any>(null);
  const [note, setNote] = useState('');
  const dialer = useDialer();
  const load = () => api('GET', `/leads/${id}`).then(setL).catch(e => Alert.alert('Could not load', e.message));
  useEffect(() => { load(); }, [id]);
  async function addNote() {
    try { await api('POST', `/leads/${id}/notes`, { body: note }); setNote(''); load(); } catch (e: any) { Alert.alert('Not saved', e.message); }
  }
  if (!l) return <View style={{ flex: 1 }}><Header title="Loading…" right={<Btn small title="Back" onPress={onBack} />} /></View>;
  return (
    <View style={{ flex: 1 }}>
      <Header title={l.name} sub={`${l.stage}${l.owner ? `, ${l.owner}` : ''}`} right={<Btn small title="Back" onPress={onBack} />} />
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <View style={{ paddingHorizontal: 16 }}>
          <Text style={{ color: C.ink2 }}>{l.primary_phone}{l.budget_max ? `   Budget ${lakh(l.budget_min) ? `${lakh(l.budget_min)}–` : ''}${lakh(l.budget_max)}` : ''}</Text>
          {l.preferred_locations?.length ? <Text style={{ color: C.ink2 }}>Wants {l.preferred_locations.join(', ')}</Text> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginVertical: 12 }}>
            <Btn title="Call" kind="primary" onPress={() => dialer.call(l.id, l.primary_phone)} />
            <Btn title="WhatsApp" onPress={() => whatsapp(l.primary_phone)} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
            <TextInput style={[s.input, { flex: 1 }]} placeholder="Add a note" placeholderTextColor={C.ink3} value={note} onChangeText={setNote} />
            <Btn title="Add" onPress={addNote} disabled={!note.trim()} />
          </View>
        </View>
        {l.timeline.slice(0, 30).map((t: any) => (
          <View key={t.id} style={s.card}>
            <Text style={{ fontWeight: '600' }}>{t.type === 'stage_change' ? `Moved to ${t.meta?.to_name}` : t.type === 'note' ? 'Note' : t.type === 're_enquiry' ? 'Enquired again' : t.body}</Text>
            {t.type !== 'system' && t.body ? <Text>{t.body}</Text> : null}
            <Text style={{ color: C.ink3, fontSize: 12 }}>{t.actor ?? 'System'}, {when(t.occurred_at)}</Text>
          </View>))}
      </ScrollView>
      {dialer.modal}
    </View>
  );
}
