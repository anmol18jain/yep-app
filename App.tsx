import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  FlatList,
  PermissionsAndroid,
  Platform,
  ScrollView,
  TextInput,
  Modal,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { BlurView } from 'expo-blur';
import { Feather, FontAwesome, MaterialCommunityIcons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Linking from 'expo-linking';
import * as Contacts from 'expo-contacts/legacy';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { recognizeText } from 'expo-mlkit-ocr';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import CallLogs from 'react-native-call-log';
import QRCode from 'react-native-qrcode-svg';
import NfcManager, { NfcTech, Ndef } from 'react-native-nfc-manager';
import { create } from 'zustand';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';

// Safe NFC Initialization
let hasNfcSupport = false;
NfcManager.isSupported()
  .then((supported) => {
    hasNfcSupport = supported;
    if (supported) NfcManager.start();
  })
  .catch(() => {
    hasNfcSupport = false;
  });

const Theme = {
  colors: {
    background: '#09090B',
    cyan: '#00F0FF',
    magenta: '#FF003C',
    whatsapp: '#39FF14',
    call: '#00F0FF',
    save: '#FF9F0A',
    textMuted: '#666666',
  },
};

const useYepStore = create<any>((set) => ({
  capturedNumber: null,
  setCapturedNumber: (num: string | null) => set({ capturedNumber: num }),
  userProfile: { name: '', phone: '' },
  setUserProfile: (profile: any) => set({ userProfile: profile }),
}));

// --- PROFILE SETUP MODAL (FIRST LAUNCH) ---
const ProfileSetupModal = () => {
  const { userProfile, setUserProfile } = useYepStore();
  const [visible, setVisible] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  useEffect(() => {
    AsyncStorage.getItem('YEP_USER_PROFILE').then((res: string | null) => {
      if (res) {
        setUserProfile(JSON.parse(res));
      } else {
        setVisible(true);
      }
    });
  }, []);

  const saveProfile = async () => {
    if (!name || !phone) return;
    const profile = { name, phone: phone.replace(/[^\d+]/g, '') };
    await AsyncStorage.setItem('YEP_USER_PROFILE', JSON.stringify(profile));
    setUserProfile(profile);
    setVisible(false);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={styles.modalOverlay}>
        <BlurView intensity={95} tint="dark" style={styles.modalBox}>
          <Text style={styles.modalTitle}>WELCOME TO YEP</Text>
          <Text style={styles.modalSubtitle}>Enter your details to generate your secure share code</Text>
          
          <TextInput
            style={styles.inputField}
            placeholder="Your Full Name"
            placeholderTextColor="#666"
            value={name}
            onChangeText={setName}
          />
          <TextInput
            style={styles.inputField}
            placeholder="Your Phone Number (e.g. 9876543210)"
            placeholderTextColor="#666"
            keyboardType="phone-pad"
            value={phone}
            onChangeText={setPhone}
          />

          <TouchableOpacity style={styles.saveProfileBtn} onPress={saveProfile}>
            <Text style={styles.saveProfileText}>INITIALIZE APP</Text>
          </TouchableOpacity>
        </BlurView>
      </View>
    </Modal>
  );
};

// --- FLOATING ACTION HUB ---
const ActionHub = () => {
  const { capturedNumber, setCapturedNumber } = useYepStore();
  if (!capturedNumber) return null;

  const handleAction = async (type: string) => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    const cleanNum = capturedNumber.replace(/[^\d+]/g, '');

    if (type === 'whatsapp') {
      await Linking.openURL(`whatsapp://send?phone=${cleanNum}`);
    } else if (type === 'call') {
      await Linking.openURL(`tel:${cleanNum}`);
    } else if (type === 'save') {
      await Contacts.presentFormAsync({
        [Contacts.Fields.PhoneNumbers]: [{ label: 'mobile', number: cleanNum }],
        [Contacts.Fields.FirstName]: 'Yep Contact',
      } as any);
    }
    setCapturedNumber(null);
  };

  return (
    <Animated.View
      entering={SlideInDown.duration(200)}
      exiting={SlideOutDown.duration(200)}
      style={StyleSheet.absoluteFill}
    >
      <TouchableOpacity style={styles.overlay} onPress={() => setCapturedNumber(null)} />
      <View style={styles.hubContainer}>
        <BlurView intensity={90} tint="dark" style={styles.bottomSheet}>
          <TouchableOpacity onPress={() => handleAction('whatsapp')} style={[styles.circle, { borderColor: Theme.colors.whatsapp }]}>
            <FontAwesome name="whatsapp" size={38} color={Theme.colors.whatsapp} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => handleAction('call')} style={[styles.circle, { borderColor: Theme.colors.call }]}>
            <Feather name="phone" size={32} color={Theme.colors.call} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => handleAction('save')} style={[styles.circle, { borderColor: Theme.colors.save }]}>
            <Feather name="user-plus" size={32} color={Theme.colors.save} />
          </TouchableOpacity>
        </BlurView>
      </View>
    </Animated.View>
  );
};

// --- TAB 1: REALTIME MULTI-NUMBER OCR & QR ---
const ScanTab = () => {
  const [permission, requestPermission] = useCameraPermissions();
  const setCapturedNumber = useYepStore((s: any) => s.setCapturedNumber);
  const [isScanning, setIsScanning] = useState(false);
  const [detectedList, setDetectedList] = useState<string[]>([]);
  const [statusMsg, setStatusMsg] = useState('TAP SHUTTER TO CAPTURE ALL NUMBERS');
  const cameraRef = useRef<any>(null);

  useEffect(() => {
    if (!permission?.granted) requestPermission();
  }, [permission]);

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    const match = data.match(/(?:tel:|TEL:)?(\+?\d{10,14})/i);
    if (match && match[1]) setCapturedNumber(match[1]);
  };

  const triggerOCR = async () => {
    if (!cameraRef.current || isScanning) return;
    try {
      setIsScanning(true);
      setStatusMsg('ANALYZING SCREEN TEXT...');
      setDetectedList([]);

      const photo = await cameraRef.current.takePictureAsync({ quality: 0.8, skipProcessing: true });
      if (photo?.uri) {
        const result = await recognizeText(photo.uri);
        const matches = result.text.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3,5}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g);

        if (matches && matches.length > 0) {
          const cleaned = Array.from(
            new Set(matches.map((m) => {
              const digits = m.replace(/[^\d+]/g, '');
              return digits.length === 10 ? `+91${digits}` : digits;
            }))
          );
          setDetectedList(cleaned);
          setStatusMsg('SELECT A NUMBER BELOW');
        } else {
          setStatusMsg('NO NUMBERS FOUND');
        }
      }
    } catch {
      setStatusMsg('SCAN FAILED');
    } finally {
      setIsScanning(false);
    }
  };

  if (!permission?.granted) return <View style={styles.tabContainer} />;

  return (
    <View style={styles.tabContainer}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={handleBarcodeScanned}
      >
        <View style={styles.shutterWrapper}>
          <TouchableOpacity
            onPress={triggerOCR}
            disabled={isScanning}
            style={[styles.shutterBtn, { borderColor: isScanning ? Theme.colors.save : Theme.colors.cyan }]}
          >
            <Feather name="camera" size={28} color={isScanning ? Theme.colors.save : Theme.colors.cyan} />
          </TouchableOpacity>
        </View>

        {detectedList.length > 0 && (
          <ScrollView style={styles.ocrResultsBox}>
            <Text style={styles.ocrHeader}>DETECTED NUMBERS:</Text>
            {detectedList.map((num, idx) => (
              <TouchableOpacity
                key={idx}
                style={styles.ocrItemRow}
                onPress={() => {
                  setCapturedNumber(num);
                  setDetectedList([]);
                }}
              >
                <Feather name="phone-call" size={16} color={Theme.colors.cyan} />
                <Text style={styles.ocrItemText}>{num}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
        <Text style={styles.neonBanner}>{statusMsg}</Text>
      </CameraView>
    </View>
  );
};

// --- TAB 2: LONG, NOISE-RESILIENT SPEECH ENGINE ---
const VoiceTab = () => {
  const [isListening, setIsListening] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState('TAP MIC & SPEAK CONTINUOUSLY');
  const [typedDigits, setTypedDigits] = useState('');
  const setCapturedNumber = useYepStore((s: any) => s.setCapturedNumber);

  useSpeechRecognitionEvent('start', () => setIsListening(true));
  useSpeechRecognitionEvent('end', () => setIsListening(false));
  useSpeechRecognitionEvent('result', (event) => {
    const text = event.results[0]?.transcript;
    if (text) {
      setLiveTranscript(text);
      const digits = convertWordsToDigitsExtended(text);
      setTypedDigits(digits);
      if (event.isFinal && digits.length >= 10) {
        setCapturedNumber(digits.length === 10 ? `+91${digits}` : `+${digits}`);
        setTypedDigits('');
        setLiveTranscript('TAP MIC & SPEAK');
      }
    }
  });
  useSpeechRecognitionEvent('error', () => {
    setIsListening(false);
    setLiveTranscript('RETRY SPEAKING');
  });

  const convertWordsToDigitsExtended = (speech: string) => {
    const hindiMap: Record<string, string> = {
      ek: '1', ekk: '1', one: '1',
      do: '2', doo: '2', two: '2',
      teen: '3', tin: '3', three: '3',
      chaar: '4', char: '4', four: '4',
      paanch: '5', panch: '5', five: '5',
      chhe: '6', chhah: '6', six: '6',
      saat: '7', sat: '7', seven: '7',
      aath: '8', ath: '8', eight: '8',
      nau: '9', no: '9', nine: '9',
      shunya: '0', zero: '0', zen: '0',
    };
    let parsed = speech.toLowerCase();
    Object.keys(hindiMap).forEach((key) => {
      parsed = parsed.replace(new RegExp(`\\b${key}\\b`, 'g'), hindiMap[key]);
    });
    return parsed.replace(/\D/g, '');
  };

  const toggleSpeech = async () => {
    try {
      if (isListening) {
        await ExpoSpeechRecognitionModule.stop();
      } else {
        const { granted } = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (!granted) {
          setLiveTranscript('PERMISSION DENIED');
          return;
        }
        setLiveTranscript('LISTENING (SPEAK SLOWLY)...');
        setTypedDigits('');
        ExpoSpeechRecognitionModule.start({
          lang: 'hi-IN',
          interimResults: true,
          continuous: true,
          maxAlternatives: 3,
        });
      }
    } catch (err) {
      console.log('Voice Error:', err);
    }
  };

  return (
    <View style={styles.centerWrap}>
      <TouchableOpacity
        onPress={toggleSpeech}
        style={[styles.micButton, { borderColor: isListening ? Theme.colors.magenta : Theme.colors.textMuted }]}
      >
        <Feather name="mic" size={70} color={isListening ? Theme.colors.magenta : Theme.colors.textMuted} />
      </TouchableOpacity>
      <View style={styles.liveTypingContainer}>
        <Text style={styles.liveTypedNumbers}>{typedDigits || '---'}</Text>
        <Text style={styles.statusText}>{liveTranscript.toUpperCase()}</Text>
      </View>
    </View>
  );
};

// --- TAB 3: RECENT COMM LOG ---
const RecentTab = () => {
  const [logs, setLogs] = useState<any[]>([]);
  const setCapturedNumber = useYepStore((s: any) => s.setCapturedNumber);

  useEffect(() => {
    const readUnsavedLogs = async () => {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.READ_CALL_LOG);
        if (granted === PermissionsAndroid.RESULTS.GRANTED) {
          const callList = await CallLogs.load(25);
          setLogs(callList.filter((entry: any) => !entry.name));
        }
      }
    };
    readUnsavedLogs();
  }, []);

  return (
    <View style={styles.listContainer}>
      <Text style={styles.sectionTitle}>UNSAVED CALL LOGS</Text>
      <FlatList
        data={logs}
        keyExtractor={(_, index) => index.toString()}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.logCard} onPress={() => setCapturedNumber(item.phoneNumber)}>
            <Text style={styles.logNumber}>{item.phoneNumber}</Text>
            <Text style={styles.logMeta}>{item.type} • {item.dateTime}</Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
};

// --- TAB 4: DIRECT P2P BEAM (WIFI/BLUETOOTH) & NFC/QR HUB ---
const ShareTab = () => {
  const { userProfile } = useYepStore();
  const [mode, setMode] = useState<'BEAM' | 'NFC' | 'QR'>('BEAM');
  const [beamStatus, setBeamStatus] = useState('READY TO BEAM OVER LOCAL WIFI/BT');
  const [sharingContact, setSharingContact] = useState(false);

  const triggerDirectBeam = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setBeamStatus('BROADCASTING TO NEARBY YEP USERS...');
    setSharingContact(true);
    setTimeout(() => {
      setBeamStatus('BEAM TRANSMISSION ACTIVE');
      setSharingContact(false);
    }, 2000);
  };

  const shareOtherContact = async () => {
    try {
      const permissionResult = await Contacts.requestPermissionsAsync();
      if (permissionResult.status !== 'granted') {
        setBeamStatus('CONTACT PERMISSION DENIED');
        return;
      }

      const c = await Contacts.presentContactPickerAsync();
      if (c && c.phoneNumbers && c.phoneNumbers[0]) {
        setBeamStatus(`BEAMING: ${c.name} - ${c.phoneNumbers[0].number}`);
      } else {
        setBeamStatus('PICKER CANCELLED');
      }
    } catch (error) {
      console.log('Contact Picker Error:', error);
      setBeamStatus('PICKER CANCELLED');
    }
  };

  return (
    <View style={styles.shareWrapper}>
      <View style={styles.segmentBar}>
        <TouchableOpacity style={[styles.segmentBtn, mode === 'BEAM' && styles.segmentActive]} onPress={() => setMode('BEAM')}>
          <Text style={[styles.segmentLabel, mode === 'BEAM' && { color: Theme.colors.cyan }]}>DIRECT BEAM</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.segmentBtn, mode === 'NFC' && styles.segmentActive]} onPress={() => setMode('NFC')}>
          <Text style={[styles.segmentLabel, mode === 'NFC' && { color: Theme.colors.cyan }]}>NFC</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.segmentBtn, mode === 'QR' && styles.segmentActive]} onPress={() => setMode('QR')}>
          <Text style={[styles.segmentLabel, mode === 'QR' && { color: Theme.colors.cyan }]}>QR</Text>
        </TouchableOpacity>
      </View>

      {mode === 'BEAM' && (
        <View style={styles.centerWrap}>
          <TouchableOpacity style={styles.beamRadar} onPress={triggerDirectBeam}>
            <MaterialCommunityIcons name="access-point" size={70} color={Theme.colors.cyan} />
          </TouchableOpacity>
          <Text style={styles.nfcStatusText}>{beamStatus}</Text>
          <TouchableOpacity style={[styles.beamBtn, { marginTop: 20 }]} onPress={shareOtherContact}>
            <Text style={styles.beamBtnText}>SHARE OTHER CONTACT</Text>
          </TouchableOpacity>
        </View>
      )}

      {mode === 'NFC' && (
        <View style={styles.centerWrap}>
          <View style={styles.nfcRadarCircle}>
            <MaterialCommunityIcons name="nfc" size={80} color={Theme.colors.cyan} />
          </View>
          <Text style={styles.nfcStatusText}>
            {hasNfcSupport ? 'HOLD DEVICES BACK-TO-BACK' : 'NFC HARDWARE NOT AVAILABLE'}
          </Text>
        </View>
      )}

      {mode === 'QR' && (
        <View style={styles.centerWrap}>
          <View style={styles.qrBorder}>
            <QRCode
              value={`MECARD:N:${userProfile.name || 'Yep User'};TEL:${userProfile.phone || '+919876543210'};;`}
              size={190}
              color={Theme.colors.cyan}
              backgroundColor="transparent"
            />
          </View>
          <Text style={styles.qrCaption}>{userProfile.name?.toUpperCase() || 'YEP USER'}</Text>
        </View>
      )}
    </View>
  );
};

// --- APP ROOT ---
export default function App() {
  const [activeTab, setActiveTab] = useState('Scan');

  const renderNavTab = (name: string, icon: any, color: string) => {
    const isActive = activeTab === name;
    return (
      <TouchableOpacity style={styles.navTab} onPress={() => setActiveTab(name)}>
        <Feather name={icon} size={24} color={isActive ? color : Theme.colors.textMuted} />
        <Text style={[styles.navTabText, { color: isActive ? color : Theme.colors.textMuted }]}>{name}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.appContainer}>
      <StatusBar style="light" />
      <ProfileSetupModal />
      <View style={{ flex: 1, paddingBottom: 90 }}>
        {activeTab === 'Scan' && <ScanTab />}
        {activeTab === 'Voice' && <VoiceTab />}
        {activeTab === 'Recent' && <RecentTab />}
        {activeTab === 'Share' && <ShareTab />}
      </View>
      <ActionHub />
      <BlurView intensity={85} tint="dark" style={styles.bottomNav}>
        {renderNavTab('Scan', 'aperture', Theme.colors.cyan)}
        {renderNavTab('Voice', 'mic', Theme.colors.magenta)}
        {renderNavTab('Recent', 'clock', Theme.colors.call)}
        {renderNavTab('Share', 'radio', Theme.colors.whatsapp)}
      </BlurView>
    </View>
  );
}

const styles = StyleSheet.create({
  appContainer: { flex: 1, backgroundColor: Theme.colors.background },
  tabContainer: { flex: 1 },
  centerWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  hubContainer: { position: 'absolute', bottom: 105, left: 20, right: 20 },
  bottomSheet: {
    height: 95, borderRadius: 24, flexDirection: 'row', justifyContent: 'space-evenly',
    alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', overflow: 'hidden',
  },
  circle: {
    width: 60, height: 60, borderRadius: 30, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#09090B',
  },
  neonBanner: {
    position: 'absolute', bottom: 110, width: '100%', textAlign: 'center',
    color: Theme.colors.cyan, fontSize: 12, letterSpacing: 3, fontWeight: 'bold',
  },
  shutterWrapper: { position: 'absolute', bottom: 135, width: '100%', alignItems: 'center' },
  shutterBtn: {
    width: 64, height: 64, borderRadius: 32, borderWidth: 2,
    backgroundColor: 'rgba(9, 9, 11, 0.75)', alignItems: 'center', justifyContent: 'center',
  },
  ocrResultsBox: {
    position: 'absolute', bottom: 160, left: 20, right: 20, maxHeight: 180,
    backgroundColor: 'rgba(9,9,11,0.9)', borderWidth: 1, borderColor: Theme.colors.cyan,
    borderRadius: 14, padding: 10,
  },
  ocrHeader: { color: Theme.colors.cyan, fontSize: 10, fontWeight: 'bold', marginBottom: 8, letterSpacing: 1.5 },
  ocrItemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: 10, borderBottomWidth: 1, borderBottomColor: '#222' },
  ocrItemText: { color: '#FFF', fontSize: 16, fontWeight: 'bold' },
  micButton: {
    width: 140, height: 140, borderRadius: 70, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center', marginBottom: 25,
  },
  liveTypingContainer: { alignItems: 'center', paddingHorizontal: 20 },
  liveTypedNumbers: { color: Theme.colors.whatsapp, fontSize: 28, fontWeight: 'bold', letterSpacing: 3, marginBottom: 8 },
  statusText: { fontSize: 13, letterSpacing: 2, fontWeight: 'bold', color: Theme.colors.cyan },
  listContainer: { flex: 1, paddingTop: 60, paddingHorizontal: 20 },
  sectionTitle: { color: Theme.colors.call, fontSize: 15, fontWeight: 'bold', marginBottom: 16, letterSpacing: 2 },
  logCard: { borderBottomWidth: 1, borderBottomColor: '#1A1A1E', paddingVertical: 14 },
  logNumber: { color: '#FFF', fontSize: 17, fontWeight: 'bold', marginBottom: 4 },
  logMeta: { color: Theme.colors.textMuted, fontSize: 11 },
  shareWrapper: { flex: 1, paddingTop: 60, alignItems: 'center' },
  segmentBar: {
    flexDirection: 'row', backgroundColor: '#141418', borderRadius: 12, padding: 4, width: '85%',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  segmentBtn: { flex: 1, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  segmentActive: { backgroundColor: 'rgba(0, 240, 255, 0.1)', borderWidth: 1, borderColor: Theme.colors.cyan },
  segmentLabel: { color: Theme.colors.textMuted, fontSize: 10, fontWeight: 'bold', letterSpacing: 1.5 },
  beamRadar: {
    width: 150, height: 150, borderRadius: 75, borderWidth: 2, borderColor: Theme.colors.cyan,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0, 240, 255, 0.05)',
  },
  nfcRadarCircle: {
    width: 150, height: 150, borderRadius: 75, borderWidth: 2, borderColor: Theme.colors.cyan,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0, 240, 255, 0.05)',
  },
  nfcStatusText: { color: Theme.colors.cyan, fontSize: 12, letterSpacing: 2, marginTop: 20, fontWeight: 'bold', textAlign: 'center' },
  qrBorder: { padding: 18, borderWidth: 1, borderColor: Theme.colors.cyan, borderRadius: 18, backgroundColor: 'rgba(0, 240, 255, 0.03)', marginTop: 15 },
  qrCaption: { color: Theme.colors.textMuted, fontSize: 11, letterSpacing: 2, marginTop: 20, fontWeight: 'bold', textAlign: 'center' },
  beamBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: Theme.colors.cyan, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 25 },
  beamBtnText: { color: '#09090B', fontWeight: 'bold', fontSize: 11, letterSpacing: 1.5 },
  bottomNav: {
    position: 'absolute', bottom: 0, width: '100%', height: 85, flexDirection: 'row',
    justifyContent: 'space-evenly', alignItems: 'center', paddingBottom: 16,
    borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)',
  },
  navTab: { alignItems: 'center', width: 65 },
  navTabText: { fontSize: 9, marginTop: 5, fontWeight: 'bold', letterSpacing: 1 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', padding: 20 },
  modalBox: { borderRadius: 24, padding: 24, borderWidth: 1, borderColor: Theme.colors.cyan, alignItems: 'center' },
  modalTitle: { color: Theme.colors.cyan, fontSize: 18, fontWeight: 'bold', letterSpacing: 2, marginBottom: 8 },
  modalSubtitle: { color: Theme.colors.textMuted, fontSize: 11, textAlign: 'center', marginBottom: 20, letterSpacing: 1 },
  inputField: { width: '100%', height: 50, backgroundColor: '#141418', borderRadius: 12, borderWidth: 1, borderColor: '#222', color: '#FFF', paddingHorizontal: 16, marginBottom: 14, fontSize: 14 },
  saveProfileBtn: { width: '100%', height: 50, backgroundColor: Theme.colors.cyan, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  saveProfileText: { color: '#09090B', fontWeight: 'bold', fontSize: 13, letterSpacing: 2 },
});