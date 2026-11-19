import { useState } from 'react';
import { Alert, Linking, Modal, Text, View } from 'react-native';
import { api } from './api';
import { Btn, C, Input } from '../App';

/** Click-to-call through the CRM (recorded, logged on the lead). Asks for
 *  the salesperson's number once; falls back to the dialer without a provider. */
export function useDialer() {
  const [ask, setAsk] = useState<{ leadId: string; phone: string } | null>(null);
  const [mine, setMine] = useState('');
  async function call(leadId: string, phone: string) {
    try {
      await api('POST', '/calls/click-to-call', { lead_id: leadId });
      Alert.alert('Calling', 'Your phone will ring first. Pick up and we connect the buyer.');
    } catch (e: any) {
      if (e.code === 'agent_phone_missing') setAsk({ leadId, phone });
      else if (e.code === 'calling_not_connected' || e.code === 'click_to_call_unsupported' || e.code === 'feature_not_in_plan' || e.status === 0) Linking.openURL(`tel:${phone}`);
      else Alert.alert('Could not call', e.message);
    }
  }
  const modal = (
    <Modal visible={!!ask} transparent animationType="fade" onRequestClose={() => setAsk(null)}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,.5)', justifyContent: 'center', padding: 24 }}>
        <View style={{ backgroundColor: C.surface, borderRadius: 8, padding: 18 }}>
          <Text style={{ fontSize: 17, fontWeight: '700', marginBottom: 6 }}>Your mobile number</Text>
          <Text style={{ color: C.ink2, marginBottom: 12 }}>Calls ring you first, then the buyer, who sees the company number.</Text>
          <Input label="Mobile" value={mine} onChangeText={setMine} keyboardType="phone-pad" />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}><Btn title="Cancel" onPress={() => setAsk(null)} /></View>
            <View style={{ flex: 1 }}><Btn title="Save and call" kind="primary" disabled={mine.length < 10} onPress={async () => {
              try { await api('PATCH', '/me', { phone: mine }); const a = ask!; setAsk(null); call(a.leadId, a.phone); }
              catch (e: any) { Alert.alert('Not saved', e.message); }
            }} /></View>
          </View>
        </View>
      </View>
    </Modal>
  );
  return { call, modal };
}

export const whatsapp = (phone: string) => Linking.openURL(`https://wa.me/${phone.replace(/\D/g, '')}`);
export function when(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const t = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today ${t}`;
  return `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} ${t}`;
}
export const humanize = (x: string) => x.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
