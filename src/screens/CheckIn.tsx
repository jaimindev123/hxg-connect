import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import { useRef, useState } from 'react';
import { Alert, Image, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { Btn, C, Header, s } from '../../App';
import { submitCheckIn } from '../queue';

const TYPES = [['day_start', 'Start my day'], ['site_visit_in', 'Arrived at site'], ['site_visit_out', 'Leaving site'],
  ['meeting', 'Client meeting'], ['adhoc', 'Share location'], ['day_end', 'End my day']] as const;

/** Front camera only: there is deliberately no gallery picker, so an old
 *  photo can't be submitted. Android reports mock-location apps. */
export default function CheckIn({ onSaved }: { onSaved: () => void }) {
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [type, setType] = useState<string>('day_start');
  const [photo, setPhoto] = useState<{ uri: string; at: string } | null>(null);
  const [pos, setPos] = useState<Location.LocationObject | null>(null);
  const [geoErr, setGeoErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function locate() {
    setGeoErr('');
    const p = await Location.requestForegroundPermissionsAsync();
    if (p.status !== 'granted') { setGeoErr('Location permission is needed to check in.'); return; }
    try { setPos(await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })); }
    catch { setGeoErr('No GPS fix yet. Step outside or near a window and try again.'); }
  }
  async function snap() {
    const pic = await cam.current?.takePictureAsync({ quality: 0.5 });
    if (pic?.uri) { setPhoto({ uri: pic.uri, at: new Date().toISOString() }); if (!pos) locate(); }
  }
  async function send() {
    if (!photo || !pos) return;
    setBusy(true);
    try {
      const r = await submitCheckIn(photo.uri, {
        type, lat: String(pos.coords.latitude), lng: String(pos.coords.longitude),
        accuracy_m: String(Math.round(pos.coords.accuracy ?? 9999)), captured_at: photo.at, mock_location: String(!!pos.mocked),
      });
      Alert.alert(r.queued ? 'Saved on your phone' : 'Checked in',
        r.queued ? 'No signal right now. It sends automatically, with the time you took it.'
          : r.flagged ? 'Sent. Your manager will review it (weak GPS or location flagged).' : 'Your manager has it.');
      setPhoto(null); setPos(null); onSaved();
    } catch (e: any) { Alert.alert('Not sent', e.message); } finally { setBusy(false); }
  }

  if (!perm) return <View style={{ flex: 1 }} />;
  if (!perm.granted) return (
    <View style={{ flex: 1 }}><Header title="Check in" />
      <View style={{ padding: 16 }}><Text style={{ marginBottom: 12, color: C.ink2 }}>Check-ins need a selfie from the front camera.</Text>
        <Btn title={perm.canAskAgain ? 'Allow camera' : 'Open settings'} kind="primary" onPress={() => (perm.canAskAgain ? requestPerm() : Linking.openSettings())} /></View></View>
  );
  const acc = pos?.coords.accuracy ? Math.round(pos.coords.accuracy) : null;
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
      <Header title="Check in" sub="Your location is shared only when you check in." />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, marginBottom: 8 }}>{TYPES.map(([k, l]) => (
        <Pressable key={k} style={[s.chip, type === k && s.chipOn]} onPress={() => setType(k)}><Text style={{ color: type === k ? '#fff' : C.ink }}>{l}</Text></Pressable>))}</View>
      <View style={{ marginHorizontal: 16, aspectRatio: 3 / 4, borderRadius: 8, overflow: 'hidden', backgroundColor: C.line }}>
        {photo ? <Image source={{ uri: photo.uri }} style={{ flex: 1 }} /> : <CameraView ref={cam} style={{ flex: 1 }} facing="front" mirror animateShutter />}
      </View>
      <View style={{ padding: 16 }}>
        {geoErr ? <Text style={s.error}>{geoErr}</Text>
          : pos ? <Text style={{ marginBottom: 10, color: pos.mocked || (acc ?? 999) > 100 ? C.brick : C.ink2 }}>
              {pos.mocked ? 'A location-faking app seems to be active. This check-in will be flagged.' : `Location found, accurate to ${acc} m${(acc ?? 0) > 100 ? ' (weak, will be flagged)' : ''}.`}</Text>
          : photo ? <Text style={{ marginBottom: 10, color: C.ink2 }}>Getting your location…</Text> : null}
        {photo ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}><Btn title="Retake" onPress={() => { setPhoto(null); }} /></View>
            <View style={{ flex: 1 }}><Btn title={busy ? 'Sending…' : 'Send check-in'} kind="primary" disabled={busy || !pos} onPress={send} /></View>
          </View>
        ) : <Btn title="Take selfie" kind="primary" onPress={snap} />}
        {geoErr ? <View style={{ marginTop: 8 }}><Btn title="Try location again" onPress={locate} /></View> : null}
      </View>
    </ScrollView>
  );
}
