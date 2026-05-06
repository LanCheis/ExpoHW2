import { Audio } from 'expo-av';
import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

const appExtra =
  (Constants.expoConfig?.extra as Record<string, string> | undefined) ??
  // Fallbacks for different Expo runtime manifests
  ((Constants as { manifest?: { extra?: Record<string, string> } }).manifest?.extra) ??
  ((Constants as { manifest2?: { extra?: Record<string, string> } }).manifest2?.extra) ??
  {};

const ASSEMBLYAI_API_KEY = appExtra.assemblyaiApiKey ?? '';
const GENIUS_ACCESS_TOKEN = appExtra.geniusAccessToken ?? '';
const AUDD_API_TOKEN = appExtra.auddApiToken ?? '';

const LANGUAGE_OPTIONS = [
  { label: 'Vietnamese', value: 'vi' },
  { label: 'English', value: 'en' },
];

type SongResult = {
  id: number;
  title: string;
  artist: string;
  fullTitle: string;
  songUrl: string;
  imageUrl?: string;
  previewUrl?: string;
  source: 'audd' | 'genius';
};

type HistoryItem = {
  id: string;
  transcript: string;
  cleaned: string;
  result?: SongResult;
  createdAt: string;
};

const RECORDING_PRESET = Audio.RecordingOptionsPresets.HIGH_QUALITY;
const CHUNK_MS = 8000;
const VU_MIN_DB = -60;
const VU_MAX_DB = -10;

export default function App() {
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [transcriptText, setTranscriptText] = useState('');
  const [cleanedText, setCleanedText] = useState('');
  const [songResult, setSongResult] = useState<SongResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [language, setLanguage] = useState(LANGUAGE_OPTIONS[0].value);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [vuLevel, setVuLevel] = useState(0);
  const [chunkCount, setChunkCount] = useState(0);
  const [candidates, setCandidates] = useState<
    Array<{ id: string; title: string; artist: string; score: number; source: string; result: SongResult }>
  >([]);
  const [bestScore, setBestScore] = useState(0);
  const bestScoreRef = useRef(0);
  const [previewSound, setPreviewSound] = useState<Audio.Sound | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const previewSoundRef = useRef<Audio.Sound | null>(null);

  const chunkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionRef = useRef(0);
  const isStoppingRef = useRef(false);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const chunkIndexRef = useRef(0);

  const hasKeys = useMemo(() => {
    return ASSEMBLYAI_API_KEY.trim().length > 10 &&
      GENIUS_ACCESS_TOKEN.trim().length > 10 &&
      AUDD_API_TOKEN.trim().length > 10;
  }, []);

  useEffect(() => {
    previewSoundRef.current = previewSound;
  }, [previewSound]);

  useEffect(() => {
    return () => {
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }
      if (previewSoundRef.current) {
        previewSoundRef.current.unloadAsync().catch(() => {});
        previewSoundRef.current = null;
      }
      clearChunkTimer();
    };
  }, []);

  const normalizeLyrics = (text: string) => {
    const noPunctuation = text
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return noPunctuation;
  };

  const buildSearchQueries = (cleaned: string) => {
    const words = cleaned.split(' ').filter((word) => word.length > 2);
    const uniqueWords = Array.from(new Set(words));
    const topKeywords = [...uniqueWords].sort((a, b) => b.length - a.length).slice(0, 6);
    const firstPhrase = words.slice(0, 8).join(' ');
    const middlePhrase = words.slice(Math.max(0, Math.floor(words.length / 3)), Math.max(8, Math.floor(words.length / 3) + 8)).join(' ');

    const queries = [
      cleaned,
      firstPhrase,
      middlePhrase,
      topKeywords.join(' '),
    ]
      .map((item) => item.trim())
      .filter((item) => item.length >= 6);

    return Array.from(new Set(queries));
  };

  const startRecording = async () => {
    setErrorMessage('');
    setStatusMessage('');
    setSongResult(null);
    setBestScore(0);
    bestScoreRef.current = 0;
    setTranscriptText('');
    setCleanedText('');
    setCandidates([]);
    setChunkCount(0);
    chunkIndexRef.current = 0;
    stopPreview().catch(() => {});

    if (!hasKeys) {
      Alert.alert('Missing API keys', 'Please add AssemblyAI, Genius, and AudD keys in App.tsx.');
      return;
    }

    try {
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        setErrorMessage('Microphone permission is required.');
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      activeSessionRef.current += 1;
      isStoppingRef.current = false;
      await startChunk(activeSessionRef.current);
      setIsRecording(true);
    } catch (error) {
      setErrorMessage('Cannot start recording. Please try again.');
    }
  };

  const stopRecording = async () => {
    const currentRecording = recordingRef.current;
    if (!currentRecording || isStoppingRef.current) {
      return;
    }

    isStoppingRef.current = true;
    activeSessionRef.current += 1;
    setIsRecording(false);
    setVuLevel(0);
    clearChunkTimer();

    try {
      const stoppedRecording = currentRecording;
      setRecording(null);
      recordingRef.current = null;
      await stoppedRecording.stopAndUnloadAsync();
      const uri = stoppedRecording.getURI();

      if (!uri) {
        setErrorMessage('No audio recorded.');
        return;
      }

      await transcribeAndSearch(uri);
    } catch (error) {
      setErrorMessage('Cannot stop recording. Please try again.');
    } finally {
      isStoppingRef.current = false;
    }
  };

  const clearChunkTimer = () => {
    if (chunkTimerRef.current) {
      clearTimeout(chunkTimerRef.current);
      chunkTimerRef.current = null;
    }
  };

  const startChunk = async (sessionId: number) => {
    const newRecording = new Audio.Recording();
    await newRecording.prepareToRecordAsync({
      ...RECORDING_PRESET,
      isMeteringEnabled: true,
    });

    newRecording.setOnRecordingStatusUpdate((status) => {
      if (!status.isRecording || typeof status.metering !== 'number') {
        return;
      }
      const normalized = Math.min(
        1,
        Math.max(0, (status.metering - VU_MIN_DB) / (VU_MAX_DB - VU_MIN_DB))
      );
      setVuLevel(normalized);
    });
    newRecording.setProgressUpdateInterval(200);

    await newRecording.startAsync();
    setRecording(newRecording);
    recordingRef.current = newRecording;

    clearChunkTimer();
    chunkTimerRef.current = setTimeout(async () => {
      if (isStoppingRef.current || !newRecording) {
        return;
      }
      let uri: string | null = null;
      try {
        await newRecording.stopAndUnloadAsync();
        uri = newRecording.getURI();
      } catch {
        setErrorMessage('Không thể dừng đoạn ghi âm.');
        return;
      }

      if (sessionId !== activeSessionRef.current || isStoppingRef.current) {
        return;
      }

      void startChunk(sessionId);

      if (uri) {
        const nextIndex = chunkIndexRef.current + 1;
        chunkIndexRef.current = nextIndex;
        setChunkCount(nextIndex);
        void transcribeAndSearch(uri, true, nextIndex);
      }
    }, CHUNK_MS);
  };

  const transcribeAndSearch = async (uri: string, isChunk = false, chunkIndex?: number) => {
    if (!isChunk) {
      setIsTranscribing(true);
    }
    setErrorMessage('');
    const indexLabel = chunkIndex ?? chunkIndexRef.current + 1;
    setStatusMessage(isChunk ? `Đang nhận diện nhạc (đoạn ${indexLabel})...` : 'Đang nhận diện nhạc bằng AudD...');

    try {
      const audioResult = await identifySongByAudio(uri);
      if (audioResult) {
        setSongResult(audioResult);
        updateCandidates(audioResult, 0.92);
      }

      if (isChunk) {
        return;
      }

      setStatusMessage('Đang chuyển giọng nói thành văn bản...');
      const uploadUrl = await uploadAudioToAssemblyAI(uri);
      const transcript = await requestTranscript(uploadUrl, language);

      if (!transcript || transcript.trim().length === 0) {
        setErrorMessage('No speech detected. Please speak clearly and try again.');
        setIsTranscribing(false);
        return;
      }

      setTranscriptText(transcript);
      const normalized = normalizeLyrics(transcript);
      setCleanedText(normalized);

      if (normalized.split(' ').length < 4) {
        setErrorMessage('Nhận diện quá ngắn. Hãy nói rõ lời bài hát và giảm tiếng nhạc nền.');
        setIsTranscribing(false);
        return;
      }

      let finalResult = audioResult;
      if (!finalResult) {
        setStatusMessage('Đang tìm bài hát theo lời thoại...');
        finalResult = await searchSong(normalized);
        setSongResult(finalResult);
        if (finalResult) {
          updateCandidates(finalResult, estimateLyricsScore(normalized));
        }
      }

      if (!isChunk) {
        setHistory((prev) => [
          {
            id: String(Date.now()),
            transcript,
            cleaned: normalized,
            result: finalResult ?? undefined,
            createdAt: new Date().toISOString(),
          },
          ...prev,
        ]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Processing failed. Please try again.';
      setErrorMessage(message);
    } finally {
      if (!isChunk) {
        setIsTranscribing(false);
      }
      setStatusMessage('');
    }
  };

  const uploadAudioToAssemblyAI = async (uri: string) => {
    const audioResponse = await fetch(uri);
    const audioBlob = await audioResponse.blob();

    const response = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: {
        authorization: ASSEMBLYAI_API_KEY,
      },
      body: audioBlob,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Upload failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    return data.upload_url as string;
  };

  const requestTranscript = async (audioUrl: string, lang: string) => {
    const response = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        authorization: ASSEMBLYAI_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: audioUrl,
        language_code: lang,
        speech_models: ['universal-2'],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Transcript request failed (${response.status}): ${errBody}`);
    }

    const data = await response.json();
    const id = data.id as string;

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const statusResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
        headers: { authorization: ASSEMBLYAI_API_KEY },
      });
      const statusData = await statusResponse.json();

      if (statusData.status === 'completed') {
        return statusData.text as string;
      }

      if (statusData.status === 'error') {
        throw new Error(statusData.error || 'Transcription failed');
      }
    }

    throw new Error('Transcription timeout');
  };

  const identifySongByAudio = async (uri: string): Promise<SongResult | null> => {
    if (AUDD_API_TOKEN.trim().length < 10) {
      return null;
    }

    const formData = new FormData();
    formData.append('api_token', AUDD_API_TOKEN);
    formData.append('return', 'spotify,apple_music');
    formData.append('file', {
      uri,
      name: 'recording.m4a',
      type: 'audio/m4a',
    } as unknown as Blob);

    const response = await fetch('https://api.audd.io/', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    if (data.status !== 'success' || !data.result) {
      return null;
    }

    const previewUrl =
      data.result?.spotify?.preview_url ??
      data.result?.apple_music?.previews?.[0]?.url ??
      undefined;

    return {
      id: Number(data.result?.song_id ?? Date.now()),
      title: data.result?.title ?? 'Unknown title',
      artist: data.result?.artist ?? 'Unknown artist',
      fullTitle: `${data.result?.artist ?? 'Unknown'} - ${data.result?.title ?? 'Unknown'}`,
      songUrl: data.result?.song_link ?? '',
      imageUrl: data.result?.spotify?.album?.images?.[0]?.url,
      previewUrl,
      source: 'audd',
    };
  };

  const estimateLyricsScore = (text: string) => {
    const wordCount = text.split(' ').filter(Boolean).length;
    const score = 0.4 + Math.min(0.45, wordCount * 0.02);
    return Math.min(0.85, Math.max(0.4, score));
  };

  const updateCandidates = (result: SongResult, score: number) => {
    setCandidates((prev) => {
      const key = `${result.title}-${result.artist}`;
      const existing = prev.find((item) => item.id === key);
      const baseScore = Math.max(existing?.score ?? 0, score);
      const nextScore = existing ? Math.min(0.98, baseScore + 0.03) : baseScore;
      const next = [
        { id: key, title: result.title, artist: result.artist, score: nextScore, source: result.source, result },
        ...prev.filter((item) => item.id !== key),
      ]
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      if (next[0] && next[0].score >= 0.9) {
        setStatusMessage(`Đã có kết quả tự tin: ${next[0].title}`);
      }

      if (next[0] && next[0].score > bestScoreRef.current + 0.05) {
        setSongResult(next[0].result);
        setBestScore(next[0].score);
        bestScoreRef.current = next[0].score;
      }

      return next;
    });
  };

  const searchSong = async (query: string): Promise<SongResult | null> => {
    if (!query || query.length < 3) {
      setErrorMessage('Not enough text to search.');
      return null;
    }

    const queries = buildSearchQueries(query);
    for (const candidate of queries) {
      const response = await fetch(
        `https://api.genius.com/search?q=${encodeURIComponent(candidate)}`,
        {
          headers: {
            Authorization: `Bearer ${GENIUS_ACCESS_TOKEN}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error('Search failed');
      }

      const data = await response.json();
      const hits = data.response?.hits ?? [];
      if (hits.length > 0) {
        const song = hits[0].result;
        return {
          id: song.id,
          title: song.title,
          artist: song.primary_artist?.name ?? 'Unknown artist',
          fullTitle: song.full_title,
          songUrl: song.url,
          imageUrl: song.song_art_image_url,
          source: 'genius',
        };
      }
    }

    return null;
  };

  const clearResult = () => {
    setTranscriptText('');
    setCleanedText('');
    setSongResult(null);
    setErrorMessage('');
    stopPreview().catch(() => {});
  };

  const stopPreview = async () => {
    if (!previewSound) {
      return;
    }
    try {
      await previewSound.stopAsync();
      await previewSound.unloadAsync();
    } finally {
      setPreviewSound(null);
      setIsPreviewPlaying(false);
    }
  };

  const togglePreview = async () => {
    if (!songResult?.previewUrl) {
      return;
    }
    if (isRecording) {
      setErrorMessage('Đang ghi âm, không thể phát preview.');
      return;
    }
    if (previewSound) {
      const status = await previewSound.getStatusAsync();
      if (status.isLoaded && status.isPlaying) {
        await previewSound.pauseAsync();
        setIsPreviewPlaying(false);
        return;
      }
      await previewSound.playAsync();
      setIsPreviewPlaying(true);
      return;
    }

    setIsPreviewPlaying(true);
    const { sound } = await Audio.Sound.createAsync(
      { uri: songResult.previewUrl },
      { shouldPlay: true }
    );
    sound.setOnPlaybackStatusUpdate((status) => {
      if (!status.isLoaded) {
        return;
      }
      if (status.didJustFinish) {
        setIsPreviewPlaying(false);
      }
    });
    setPreviewSound(sound);
  };

  useEffect(() => {
    if (!previewSound) {
      return;
    }
    previewSound.unloadAsync().catch(() => {});
    setPreviewSound(null);
    setIsPreviewPlaying(false);
  }, [songResult?.previewUrl]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.container}>

        <Text style={styles.title}>LyricFind</Text>
        <Text style={styles.subtitle}>Recognize songs by voice</Text>

        <View style={styles.languageRow}>
          {LANGUAGE_OPTIONS.map((option) => (
            <Pressable
              key={option.value}
              onPress={() => setLanguage(option.value)}
              style={[
                styles.languageChip,
                language === option.value && styles.languageChipActive,
              ]}
            >
              <Text
                style={[
                  styles.languageText,
                  language === option.value && styles.languageTextActive,
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.heroSection}>
          <Pressable
            onPress={startRecording}
            disabled={isRecording || isTranscribing}
            style={[
              styles.micButton,
              (isRecording || isTranscribing) && styles.micButtonDisabled,
              isRecording && styles.micButtonRecording,
            ]}
          >
            <Text style={styles.micIcon}>●</Text>
          </Pressable>
          <View style={styles.heroControls}>
            <Pressable
              onPress={stopRecording}
              disabled={!isRecording}
              style={[styles.button, !isRecording && styles.buttonDisabled]}
            >
              <Text style={styles.buttonText}>Stop</Text>
            </Pressable>
            <Pressable onPress={clearResult} style={styles.buttonSecondary}>
              <Text style={styles.buttonSecondaryText}>Clear</Text>
            </Pressable>
          </View>
        </View>

        {isRecording && (
          <View style={styles.vuWrapper}>
            <Text style={styles.vuLabel}>Listening · chunk {Math.max(chunkCount, 1)}</Text>
            <View style={styles.vuTrack}>
              <View style={[styles.vuFill, { width: `${Math.round(vuLevel * 100)}%` }]} />
            </View>
          </View>
        )}

        {(isTranscribing || statusMessage.length > 0) && (
          <View style={styles.loadingRow}>
            <ActivityIndicator color="#CC785C" />
            <Text style={styles.loadingText}>{statusMessage || 'Processing...'}</Text>
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Result</Text>
          <View style={styles.card}>
            {songResult ? (
              <>
                <View style={styles.resultRow}>
                  {songResult.imageUrl ? (
                    <Image source={{ uri: songResult.imageUrl }} style={styles.albumArt} />
                  ) : (
                    <View style={styles.albumArtPlaceholder} />
                  )}
                  <View style={styles.resultInfo}>
                    <Text style={styles.resultTitle}>{songResult.title}</Text>
                    <Text style={styles.resultArtist}>{songResult.artist}</Text>
                    {bestScore > 0 && (
                      <View style={styles.confidenceRow}>
                        <View style={styles.confidenceBar}>
                          <View style={[styles.confidenceFill, { width: `${Math.round(bestScore * 100)}%` }]} />
                        </View>
                        <Text style={styles.confidenceText}>{Math.round(bestScore * 100)}%</Text>
                      </View>
                    )}
                    <Text style={styles.resultSource}>
                      via {songResult.source === 'audd' ? 'AudD' : 'Genius'}
                    </Text>
                  </View>
                </View>
                <Text style={styles.resultSnippet}>
                  Matched lyrics: &quot;{cleanedText.slice(0, 120)}&quot;
                </Text>
                <Text style={styles.resultLink}>
                  {songResult.songUrl || 'No link'}
                </Text>
                {songResult.previewUrl ? (
                  <Pressable
                    onPress={togglePreview}
                    style={[styles.button, styles.previewButton]}
                  >
                    <Text style={styles.buttonText}>
                      {isPreviewPlaying ? 'Stop Preview' : '▶  Preview 30s'}
                    </Text>
                  </Pressable>
                ) : (
                  <Text style={styles.mutedText}>No preview available.</Text>
                )}
              </>
            ) : (
              <Text style={styles.cardText}>No match found.</Text>
            )}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Top Matches</Text>
          {candidates.length === 0 ? (
            <Text style={styles.mutedText}>No suggestions yet.</Text>
          ) : (
            candidates.map((item) => (
              <View key={item.id} style={styles.candidateItem}>
                <View style={styles.candidateHeader}>
                  <View style={styles.candidateMeta}>
                    <Text style={styles.candidateTitle}>{item.title}</Text>
                    <Text style={styles.candidateArtist}>{item.artist}</Text>
                  </View>
                  <Text style={styles.candidateScore}>{Math.round(item.score * 100)}%</Text>
                </View>
                <View style={styles.confidenceBar}>
                  <View style={[styles.confidenceFill, { width: `${Math.round(item.score * 100)}%` }]} />
                </View>
                <Text style={styles.candidateSource}>
                  {item.source === 'audd' ? 'AudD' : 'Genius'}
                </Text>
              </View>
            ))
          )}
        </View>

        {errorMessage.length > 0 && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Transcript</Text>
          <View style={styles.card}>
            <Text style={styles.cardText}>
              {transcriptText || 'No data yet.'}
            </Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Cleaned Text</Text>
          <View style={styles.card}>
            <Text style={styles.cardText}>
              {cleanedText || 'No data yet.'}
            </Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>History</Text>
          {history.length === 0 ? (
            <Text style={styles.mutedText}>No history yet.</Text>
          ) : (
            history.map((item) => (
              <View key={item.id} style={styles.historyItem}>
                <Text style={styles.historyDate}>{item.createdAt}</Text>
                <Text style={styles.historyTitle}>
                  {item.result ? item.result.fullTitle : 'Not found'}
                </Text>
                <Text style={styles.historyMuted}>{item.transcript}</Text>
                <Text style={styles.historyMuted}>{item.cleaned}</Text>
                {item.result && (
                  <Text style={styles.historySource}>
                    {item.result.source === 'audd' ? 'AudD' : 'Genius'}
                  </Text>
                )}
              </View>
            ))
          )}
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#FAF9F5',
  },
  container: {
    padding: 24,
    paddingBottom: 60,
  },

  // Header
  title: {
    fontSize: 26,
    color: '#CC785C',
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 8,
  },
  subtitle: {
    color: '#9C9590',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 24,
  },

  // Language chips
  languageRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'center',
    marginBottom: 32,
  },
  languageChip: {
    borderWidth: 1,
    borderColor: '#D6CFC4',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#FAF9F5',
  },
  languageChipActive: {
    backgroundColor: '#CC785C',
    borderColor: '#CC785C',
  },
  languageText: {
    color: '#6B6560',
    fontSize: 13,
  },
  languageTextActive: {
    color: '#FAF9F5',
    fontWeight: '600',
  },

  // Hero record section
  heroSection: {
    alignItems: 'center',
    marginBottom: 28,
  },
  micButton: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: '#CC785C',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    borderWidth: 3,
    borderColor: '#CC785C',
  },
  micButtonDisabled: {
    opacity: 0.4,
  },
  micButtonRecording: {
    borderColor: '#E8A882',
    borderWidth: 5,
  },
  micIcon: {
    fontSize: 30,
    color: '#FAF9F5',
  },
  heroControls: {
    flexDirection: 'row',
    gap: 12,
  },

  // Buttons
  button: {
    backgroundColor: '#CC785C',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    color: '#FAF9F5',
    fontWeight: '700',
  },
  buttonSecondary: {
    borderWidth: 1,
    borderColor: '#D6CFC4',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: '#FAF9F5',
  },
  buttonSecondaryText: {
    color: '#6B6560',
  },
  previewButton: {
    marginTop: 12,
    alignSelf: 'stretch',
    alignItems: 'center',
    backgroundColor: '#7C6A52',
  },

  // VU meter
  vuWrapper: {
    marginBottom: 20,
  },
  vuLabel: {
    color: '#6B6560',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 8,
  },
  vuTrack: {
    height: 6,
    backgroundColor: '#D6CFC4',
    borderRadius: 3,
    overflow: 'hidden',
  },
  vuFill: {
    height: '100%',
    backgroundColor: '#CC785C',
    borderRadius: 3,
  },

  // Status / loading
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 20,
  },
  loadingText: {
    color: '#6B6560',
  },

  // Sections
  section: {
    marginTop: 24,
  },
  sectionTitle: {
    color: '#1C1917',
    fontWeight: '600',
    marginBottom: 10,
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },

  // Cards
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    padding: 16,
    borderWidth: 1,
    borderColor: '#D6CFC4',
  },
  cardText: {
    color: '#6B6560',
    lineHeight: 20,
    fontSize: 13,
  },

  // Result card
  resultRow: {
    flexDirection: 'row',
    gap: 14,
    marginBottom: 12,
  },
  albumArt: {
    width: 80,
    height: 80,
    borderRadius: 8,
    backgroundColor: '#F0EBE1',
  },
  albumArtPlaceholder: {
    width: 80,
    height: 80,
    borderRadius: 8,
    backgroundColor: '#F0EBE1',
  },
  resultInfo: {
    flex: 1,
    gap: 4,
    justifyContent: 'center',
  },
  resultTitle: {
    color: '#1C1917',
    fontSize: 18,
    fontWeight: '700',
  },
  resultArtist: {
    color: '#CC785C',
    fontSize: 14,
  },
  confidenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  confidenceBar: {
    flex: 1,
    height: 4,
    backgroundColor: '#D6CFC4',
    borderRadius: 2,
    overflow: 'hidden',
  },
  confidenceFill: {
    height: '100%',
    backgroundColor: '#CC785C',
    borderRadius: 2,
  },
  confidenceText: {
    color: '#7C6A52',
    fontSize: 12,
    fontWeight: '600',
    minWidth: 32,
  },
  resultSource: {
    color: '#9C9590',
    fontSize: 12,
  },
  resultSnippet: {
    color: '#6B6560',
    fontSize: 12,
    marginBottom: 6,
  },
  resultLink: {
    color: '#CC785C',
    fontSize: 12,
    marginBottom: 4,
  },

  // Candidates
  candidateItem: {
    marginTop: 10,
    padding: 14,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#D6CFC4',
  },
  candidateHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  candidateMeta: {
    flex: 1,
  },
  candidateTitle: {
    color: '#1C1917',
    fontWeight: '700',
  },
  candidateArtist: {
    color: '#6B6560',
    marginTop: 2,
    fontSize: 13,
  },
  candidateScore: {
    color: '#CC785C',
    fontWeight: '700',
    fontSize: 14,
  },
  candidateSource: {
    color: '#9C9590',
    marginTop: 6,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  // Error
  errorBox: {
    marginTop: 16,
    padding: 14,
    backgroundColor: '#FDF0ED',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E8BFB3',
  },
  errorText: {
    color: '#8B3A2A',
  },

  // Muted
  mutedText: {
    color: '#9C9590',
    fontSize: 13,
  },

  // History
  historyItem: {
    marginTop: 10,
    padding: 14,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#D6CFC4',
  },
  historyDate: {
    color: '#9C9590',
    fontSize: 11,
    marginBottom: 4,
  },
  historyTitle: {
    color: '#1C1917',
    fontWeight: '600',
    fontSize: 14,
    marginBottom: 4,
  },
  historyMuted: {
    color: '#9C9590',
    fontSize: 12,
    marginTop: 2,
  },
  historySource: {
    color: '#CC785C',
    fontSize: 11,
    marginTop: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
