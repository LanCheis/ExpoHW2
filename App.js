import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  Image,
  Platform,
  Animated,
  FlatList,
  Modal,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as AudioModule from 'expo-audio';
import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';

// API Configuration
const AUDD_API_KEY = process.env.EXPO_PUBLIC_AUDD_API_KEY || 'your_audd_api_key_here';
const AUDD_API_URL = 'https://api.audd.io/';

// Color Palette
const COLORS = {
  background: '#0f1419',
  card: 'rgba(255,255,255,0.08)',
  glassLight: 'rgba(255,255,255,0.1)',
  glassLighter: 'rgba(255,255,255,0.05)',
  text: '#f5f7fa',
  textSecondary: '#a0aec0',
  accentPurple: '#7c3aed',
  accentBlue: '#3b82f6',
  accentRed: '#ff4757',
  accentGreen: '#26de81',
};

export default function App() {
  const [recording, setRecording] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState(null);
  const [recognizedText, setRecognizedText] = useState(null);
  const [songResults, setSongResults] = useState([]);
  const [selectedResult, setSelectedResult] = useState(null);
  const [searchHistory, setSearchHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState('vi');
  const [mediaRecorder, setMediaRecorder] = useState(null);
  const audioChunksRef = useRef([]);

  // Audio Playback State (FR-11)
  const [sound, setSound] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackStatus, setPlaybackStatus] = useState(null);
  const [showPlayer, setShowPlayer] = useState(false);
  const [activeSong, setActiveSong] = useState(null);

  // Animation Values
  const micPulse = useRef(new Animated.Value(1)).current;
  const recordButtonScale = useRef(new Animated.Value(1)).current;
  const resultCardSlide = useRef(new Animated.ValueXY({ x: 0, y: 300 })).current;
  const errorSlide = useRef(new Animated.ValueXY({ x: 0, y: -100 })).current;

  useEffect(() => {
    requestPermissions();
    startMicPulseAnimation();
    loadSearchHistory();
  }, []);

  // Load search history from storage
  const loadSearchHistory = async () => {
    try {
      const history = await AsyncStorage.getItem('songSearchHistory');
      if (history) {
        setSearchHistory(JSON.parse(history));
      }
    } catch (err) {
      console.error('Error loading history:', err);
    }
  };

  // Save search to history
  const saveToHistory = async (text, results) => {
    try {
      const entry = {
        id: Date.now(),
        recognizedText: text,
        results: results,
        timestamp: new Date().toLocaleString(),
      };
      const updated = [entry, ...searchHistory].slice(0, 50);
      setSearchHistory(updated);
      await AsyncStorage.setItem('songSearchHistory', JSON.stringify(updated));
    } catch (err) {
      console.error('Error saving history:', err);
    }
  };

  // Delete history item
  const deleteHistoryItem = async (id) => {
    try {
      const updated = searchHistory.filter(item => item.id !== id);
      setSearchHistory(updated);
      await AsyncStorage.setItem('songSearchHistory', JSON.stringify(updated));
    } catch (err) {
      console.error('Error deleting history:', err);
    }
  };

  // Revisit history item
  const revisitHistoryItem = (item) => {
    setRecognizedText(item.recognizedText);
    setSongResults(item.results);
    setShowHistory(false);
    animateResultsIn();
  };

  // Clear all history
  const clearAllHistory = async () => {
    try {
      await AsyncStorage.removeItem('songSearchHistory');
      setSearchHistory([]);
      setShowHistory(false);
    } catch (err) {
      console.error('Error clearing history:', err);
    }
  };

  // Microphone Pulse Animation (breathing effect)
  const startMicPulseAnimation = () => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(micPulse, {
          toValue: 1.15,
          duration: 1500,
          useNativeDriver: false,
        }),
        Animated.timing(micPulse, {
          toValue: 1,
          duration: 1500,
          useNativeDriver: false,
        }),
      ])
    ).start();
  };

  // Record Button Press Animation
  const animateButtonPress = () => {
    Animated.sequence([
      Animated.timing(recordButtonScale, {
        toValue: 0.95,
        duration: 100,
        useNativeDriver: false,
      }),
      Animated.timing(recordButtonScale, {
        toValue: 1,
        duration: 100,
        useNativeDriver: false,
      }),
    ]).start();
  };

  // Results Card Slide-Up Animation
  const animateResultsIn = () => {
    Animated.timing(resultCardSlide, {
      toValue: { x: 0, y: 0 },
      duration: 500,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  };

  // Error Alert Slide-In Animation
  const animateErrorIn = () => {
    Animated.timing(errorSlide, {
      toValue: { x: 0, y: 0 },
      duration: 400,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  };

  // Reset animations
  const resetAnimations = () => {
    resultCardSlide.setValue({ x: 0, y: 300 });
    errorSlide.setValue({ x: 0, y: -100 });
  };

  const requestPermissions = async () => {
    try {
      if (Platform.OS === 'web') {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
      } else {
        const { status } = await AudioModule.requestRecordingPermissionsAsync();
        if (status === 'granted') {
          await AudioModule.setAudioModeAsync({
            allowsRecordingIOS: true,
            playsInSilentModeIOS: true,
          });
        } else {
          setError('Microphone permission is required. Please enable it in settings.');
          animateErrorIn();
        }
      }
    } catch (err) {
      setError(`Permission error: ${err.message}`);
      animateErrorIn();
    }
  };

  const startRecording = async () => {
    try {
      animateButtonPress();
      setError(null);
      setSongResults([]);
      setRecognizedText(null);
      setSelectedResult(null);
      resetAnimations();

      if (Platform.OS === 'web') {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        audioChunksRef.current = [];

        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        recorder.onstop = async () => {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          
          if (audioBlob.size === 0) {
            setError('Không ghi nhận được âm thanh. Vui lòng thử lại.');
            animateErrorIn();
            setIsAnalyzing(false);
            return;
          }

          const reader = new FileReader();
          reader.onloadend = async () => {
            await analyzeWebAudio(audioBlob);
          };
          reader.readAsDataURL(audioBlob);
          stream.getTracks().forEach(track => track.stop());
        };

        recorder.start();
        setMediaRecorder(recorder);
        setIsRecording(true);
      } else {
        if (recording) {
          await recording.stop();
        }

        const { recording: newRecording } = await AudioModule.Recording.createAsync(
          AudioModule.RecordingOptionsPresets.HIGH_QUALITY
        );

        setRecording(newRecording);
        setIsRecording(true);
      }
    } catch (err) {
      setError(`Recording error: ${err.message}`);
      animateErrorIn();
      setIsRecording(false);
    }
  };

  const stopRecording = async () => {
    try {
      animateButtonPress();
      setIsRecording(false);
      setIsAnalyzing(true);

      if (Platform.OS === 'web') {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
      } else {
        if (!recording) return;
        await recording.stop();
        const { uri } = await recording.getStatus();
        setRecording(null);
        await analyzeWithAudD(uri);
      }
    } catch (err) {
      setError(`Stop recording error: ${err.message}`);
      animateErrorIn();
      setIsAnalyzing(false);
    }
  };

  const analyzeWebAudio = async (audioBlob) => {
    try {
      const formData = new FormData();
      formData.append('file', audioBlob, 'recording.webm');
      formData.append('model', 'whisper-large-v3');
      formData.append('language', selectedLanguage); // FR-10: Use selected language
      
      await performSpeechToText(formData);
    } catch (err) {
      setError(`Lỗi xử lý âm thanh Web: ${err.message}`);
      animateErrorIn();
      setIsAnalyzing(false);
    }
  };

  const analyzeWithAudD = async (audioUri) => {
    try {
      const formData = new FormData();
      const fileParts = audioUri.split('/');
      const fileName = fileParts[fileParts.length - 1];

      formData.append('file', {
        uri: audioUri,
        type: 'audio/m4a',
        name: fileName,
      });
      formData.append('model', 'whisper-large-v3');
      formData.append('language', selectedLanguage); // FR-10: Use selected language
      
      await performSpeechToText(formData);
    } catch (err) {
      setError(`Lỗi chuẩn bị file âm thanh: ${err.message}`);
      animateErrorIn();
      setIsAnalyzing(false);
    }
  };

  const cleanLyricsText = (text) => {
    if (!text) return '';

    // FR-04: Step 1: Remove unnecessary characters (punctuation and special symbols)
    // We keep letters, numbers, and spaces
    let cleaned = text.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'! Vietnamese punctuation: 、。]/g, '');

    // FR-04: Step 2: Remove redundant words (filler words)
    // We remove common filler words that don't help in song identification
    const redundantWords = [
      'uhm', 'umm', 'err', 'ah', 'oh', 'yeah', 'uh', 
      'vâng', 'dạ', 'thì', 'là', 'mà', 'của', 'với'
    ];
    
    let words = cleaned.toLowerCase().split(/\s+/);
    words = words.filter(word => !redundantWords.includes(word));

    // FR-04: Step 3: Remove extra whitespace
    return words.join(' ').trim();
  };

  const searchSongByLyrics = async (lyrics) => {
    try {
      const apiKey = process.env.EXPO_PUBLIC_AUDD_API_KEY || 'your_audd_api_key_here';
      
      const response = await axios.get('https://api.audd.io/findLyrics/', {
        params: {
          api_token: apiKey,
          q: lyrics,
        },
        timeout: 30000,
      });

      if (response.data && response.data.status === 'success' && response.data.result.length > 0) {
        // FR-11: For each result, try to get a preview URL and official link from iTunes
        const enrichedResults = await Promise.all(
          response.data.result.slice(0, 5).map(async (item, index) => {
            let previewUrl = null;
            let externalUrl = null;
            let albumArt = null;

            try {
              const itunesRes = await axios.get('https://itunes.apple.com/search', {
                params: {
                  term: `${item.artist} ${item.title}`,
                  media: 'music',
                  limit: 1,
                },
              });

              if (itunesRes.data.results.length > 0) {
                const track = itunesRes.data.results[0];
                previewUrl = track.previewUrl;
                externalUrl = track.trackViewUrl;
                albumArt = track.artworkUrl100;
              }
            } catch (e) {
              console.error('iTunes search error:', e);
            }

            return {
              id: index + 1,
              title: item.title,
              artist: item.artist,
              album: item.album || 'Unknown Album',
              album_art: albumArt,
              confidence: 'Match',
              source: 'AudD + iTunes',
              preview_url: previewUrl,
              external_url: externalUrl,
              lyrics: item.lyrics,
            };
          })
        );
        return enrichedResults;
      } else {
        return [];
      }
    } catch (err) {
      console.error('Song search error:', err);
      return [];
    }
  };

  const performSpeechToText = async (formData) => {
    try {
      const apiKey = process.env.EXPO_PUBLIC_GROQ_API_KEY || 'your_groq_api_key_here';
      
      const response = await axios.post(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        formData,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'multipart/form-data',
          },
          timeout: 60000,
        }
      );

      if (response.data && response.data.text) {
        // FR-03: Get recognized text
        const rawTranscript = response.data.text;
        
        // FR-04: Analyze and clean recognized text
        const cleanedTranscript = cleanLyricsText(rawTranscript);
        setRecognizedText(cleanedTranscript);
        
        // FR-05: Search for the song using lyrics
        const results = await searchSongByLyrics(cleanedTranscript);

        if (results.length > 0) {
          // FR-06: Display Results
          setSongResults(results);
          await saveToHistory(cleanedTranscript, results);
          animateResultsIn();
        } else {
          // FR-06: Not found message
          setError('Không tìm thấy bài hát phù hợp.');
          animateErrorIn();
        }
      } else {
        setError('Không thể nhận diện được lời thoại. Vui lòng thử lại.'); // FR-07
        animateErrorIn();
      }
      setIsAnalyzing(false);
    } catch (err) {
      const errorMessage = err.response?.data?.error?.message || err.message;
      setError(`Lỗi nhận diện giọng nói: ${errorMessage}`);
      animateErrorIn();
      setIsAnalyzing(false);
    }
  };

  const extractMultipleSongResults = (response) => {
    try {
      const results = [];

      // Primary result
      if (response?.status === 'success' && response?.result) {
        const result = response.result;
        results.push({
          id: 1,
          title: result.title || 'Unknown',
          artist: result.artist || 'Unknown Artist',
          album: result.album || 'Unknown',
          album_art: result.album_art || null,
          confidence: '100%',
          source: 'Primary Match',
        });
      }

      // Simulate additional approximate results (in real app, use fuzzy search or multiple API calls)
      if (results.length > 0) {
        results.push({
          id: 2,
          title: results[0].title + ' (Remix)',
          artist: results[0].artist,
          album: 'Remixes',
          album_art: results[0].album_art,
          confidence: '85%',
          source: 'Approximate Match',
        });
        results.push({
          id: 3,
          title: results[0].title + ' (Acoustic)',
          artist: results[0].artist,
          album: 'Acoustic Versions',
          album_art: results[0].album_art,
          confidence: '78%',
          source: 'Approximate Match',
        });
      }

      return results;
    } catch (err) {
      return [];
    }
  };

  const handlePlayPreview = async (song) => {
    try {
      if (!song.preview_url) {
        setError('No preview available for this song.');
        animateErrorIn();
        return;
      }

      if (sound) {
        await sound.terminateAsync();
        setSound(null);
      }

      const { sound: newSound } = await AudioModule.Audio.createAsync(
        { uri: song.preview_url },
        { shouldPlay: true },
        (status) => setPlaybackStatus(status)
      );

      setSound(newSound);
      setIsPlaying(true);
      setActiveSong(song);
      setShowPlayer(true);
    } catch (err) {
      console.error('Playback error:', err);
      setError('Could not play preview.');
      animateErrorIn();
    }
  };

  const togglePlayback = async () => {
    if (sound) {
      if (isPlaying) {
        await sound.pauseAsync();
      } else {
        await sound.playAsync();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const resetToStart = async () => {
    if (sound) {
      await sound.setPositionAsync(0);
      await sound.playAsync();
      setIsPlaying(true);
    }
  };

  const skipForward = async () => {
    if (sound && playbackStatus) {
      const newPos = Math.min(playbackStatus.durationMillis, playbackStatus.positionMillis + 10000);
      await sound.setPositionAsync(newPos);
    }
  };

  const skipBackward = async () => {
    if (sound && playbackStatus) {
      const newPos = Math.max(0, playbackStatus.positionMillis - 10000);
      await sound.setPositionAsync(newPos);
    }
  };

  const closePlayer = async () => {
    if (sound) {
      await sound.terminateAsync();
      setSound(null);
    }
    setIsPlaying(false);
    setShowPlayer(false);
  };

  const resetApp = () => {
    setRecording(null);
    setIsRecording(false);
    setIsAnalyzing(false);
    setSongResults([]);
    setRecognizedText(null);
    setSelectedResult(null);
    setError(null);
    resetAnimations();
  };

  const micScale = micPulse.interpolate({
    inputRange: [1, 1.15],
    outputRange: [1, 1.15],
  });

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        style={styles.scrollContainer}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>🎵 Song Identifier</Text>
          <Text style={styles.subtitle}>Identify Music Instantly</Text>
        </View>

        {/* Error Alert */}
        {error && (
          <Animated.View
            style={[
              styles.errorContainer,
              { transform: [{ translateY: errorSlide.y }] }
            ]}
          >
            <View style={styles.errorContent}>
              <Text style={styles.errorIcon}>⚠️</Text>
              <Text style={styles.errorText}>{error}</Text>
            </View>
            <TouchableOpacity
              style={styles.errorClose}
              onPress={() => setError(null)}
            >
              <Text style={styles.closeIcon}>✕</Text>
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* Main Content */}
        <View style={styles.mainContent}>
          {/* Language Toggle (FR-10) */}
          <View style={styles.languageToggleContainer}>
            <TouchableOpacity 
              style={[styles.languageOption, selectedLanguage === 'vi' && styles.languageOptionActive]}
              onPress={() => setSelectedLanguage('vi')}
            >
              <Text style={[styles.languageOptionText, selectedLanguage === 'vi' && styles.languageOptionTextActive]}>🇻🇳 VN</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={[styles.languageOption, selectedLanguage === 'en' && styles.languageOptionActive]}
              onPress={() => setSelectedLanguage('en')}
            >
              <Text style={[styles.languageOptionText, selectedLanguage === 'en' && styles.languageOptionTextActive]}>🇺🇸 EN</Text>
            </TouchableOpacity>
          </View>

          {/* Microphone Icon - Animated */}
          <Animated.View
            style={[
              styles.iconContainer,
              isRecording && styles.iconContainerRecording,
              { transform: [{ scale: micScale }] }
            ]}
          >
            <Text style={styles.iconText}>{isRecording ? '🔴' : '🎤'}</Text>
            {isRecording && <View style={styles.recordingGlow} />}
          </Animated.View>

          {/* Status Text */}
          {songResults.length === 0 && (
            <View style={styles.statusContainer}>
              <Text style={styles.statusHeading}>
                {isRecording ? '🔴 Recording...' : '🎙️ Ready to Listen'}
              </Text>
              <Text style={styles.statusSubtitle}>
                {isRecording
                  ? 'Tap Stop when done'
                  : 'Record a song snippet'}
              </Text>
            </View>
          )}

          {/* Recording Indicator */}
          {isRecording && (
            <View style={styles.recordingIndicator}>
              <View style={[styles.dot, styles.dotActive]} />
              <View style={[styles.dot, styles.dotActive, { animationDelay: '0.2s' }]} />
              <View style={[styles.dot, styles.dotActive, { animationDelay: '0.4s' }]} />
            </View>
          )}

          {/* Loading State */}
          {isAnalyzing && (
            <View style={styles.loadingContainer}>
              <Animated.View style={styles.spinnerWrapper}>
                <ActivityIndicator size="large" color={COLORS.accentBlue} />
              </Animated.View>
              <Text style={styles.loadingText}>Analyzing audio...</Text>
              <Text style={styles.loadingSubtext}>Finding your song</Text>
            </View>
          )}

          {/* Record/Stop Button */}
          {songResults.length === 0 && !isAnalyzing && (
            <Animated.View
              style={[
                styles.recordButtonWrapper,
                { transform: [{ scale: recordButtonScale }] }
              ]}
            >
              <TouchableOpacity
                style={[
                  styles.recordButton,
                  isRecording && styles.recordButtonActive
                ]}
                onPress={isRecording ? stopRecording : startRecording}
                activeOpacity={0.8}
              >
                <Text style={styles.recordButtonText}>
                  {isRecording ? '⏹️ Stop & Analyze' : '▶️ Start Recording'}
                </Text>
              </TouchableOpacity>
            </Animated.View>
          )}

          {/* Recent History Preview (FR-09 update) */}
          {!isRecording && !isAnalyzing && songResults.length === 0 && searchHistory.length > 0 && (
            <View style={styles.recentHistoryContainer}>
              <Text style={styles.recentHistoryTitle}>Recent Searches</Text>
              {searchHistory.slice(0, 3).map((item) => (
                <TouchableOpacity 
                  key={item.id} 
                  style={styles.recentHistoryItem}
                  onPress={() => revisitHistoryItem(item)}
                >
                  <View style={styles.recentHistoryItemContent}>
                    <Text style={styles.recentHistoryItemText} numberOfLines={1}>
                      🔍 {item.recognizedText}
                    </Text>
                    <Text style={styles.recentHistoryItemTime}>{item.timestamp}</Text>
                  </View>
                </TouchableOpacity>
              ))}
              
              <TouchableOpacity 
                style={styles.seeAllButton}
                onPress={() => setShowHistory(true)}
              >
                <Text style={styles.seeAllButtonText}>📜 View Full History ({searchHistory.length})</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Recognized Text Display */}
        {recognizedText && songResults.length > 0 && (
          <Animated.View
            style={[
              styles.recognizedTextContainer,
              { transform: [{ translateY: resultCardSlide.y }] }
            ]}
          >
            <Text style={styles.recognizedTextLabel}>📝 Recognized Text:</Text>
            <Text style={styles.recognizedTextContent}>{recognizedText}</Text>
          </Animated.View>
        )}

        {/* Multiple Results Display */}
        {songResults.length > 0 && (
          <Animated.View
            style={[
              styles.resultsListContainer,
              { transform: [{ translateY: resultCardSlide.y }] }
            ]}
          >
            <View style={styles.resultsHeader}>
              <Text style={styles.resultsTitle}>
                🎵 Found {songResults.length} Results
              </Text>
            </View>

            <FlatList
              data={songResults}
              keyExtractor={(item) => item.id.toString()}
              scrollEnabled={false}
              renderItem={({ item, index }) => (
                <View style={styles.resultItemWrapper}>
                  <TouchableOpacity
                    style={[
                      styles.resultCard,
                      selectedResult?.id === item.id && styles.resultCardSelected
                    ]}
                    onPress={() => setSelectedResult(item)}
                  >
                    {/* Album Art */}
                    {item.album_art ? (
                      <Image
                        source={{ uri: item.album_art }}
                        style={styles.resultAlbumArt}
                      />
                    ) : (
                      <View style={styles.resultAlbumArtPlaceholder}>
                        <Text style={styles.placeholderIcon}>🎶</Text>
                      </View>
                    )}

                    {/* Song Info */}
                    <View style={styles.resultInfo}>
                      <View style={styles.resultTitleRow}>
                        <Text style={styles.resultNumber}>#{index + 1}</Text>
                        <Text style={styles.resultConfidence}>{item.confidence}</Text>
                      </View>
                      <Text style={styles.resultSongTitle} numberOfLines={2}>
                        {item.title}
                      </Text>
                      <Text style={styles.resultSongArtist} numberOfLines={1}>
                        {item.artist}
                      </Text>
                      <Text style={styles.resultSource}>{item.source}</Text>
                    </View>
                  </TouchableOpacity>

                  {/* Play Button (FR-11) */}
                  <TouchableOpacity 
                    style={styles.previewPlayBtn}
                    onPress={() => handlePlayPreview(item)}
                  >
                    <Text style={styles.previewPlayIcon}>▶️</Text>
                  </TouchableOpacity>
                </View>
              )}
            />

            {/* Action Buttons */}
            <View style={styles.actionButtonsContainer}>
              <TouchableOpacity
                style={styles.actionButton}
                onPress={resetApp}
                activeOpacity={0.8}
              >
                <Text style={styles.actionButtonText}>🔄 New Search</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        )}

        <StatusBar style="light" />
      </ScrollView>

      {/* Search History Modal */}
      <Modal
        visible={showHistory}
        transparent
        animationType="slide"
        onRequestClose={() => setShowHistory(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>📜 Search History</Text>
              <TouchableOpacity onPress={() => setShowHistory(false)}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            {searchHistory.length > 0 ? (
              <>
                <FlatList
                  data={searchHistory}
                  keyExtractor={(item) => item.id.toString()}
                  renderItem={({ item }) => (
                    <View style={styles.historyItem}>
                      <TouchableOpacity
                        style={styles.historyItemContent}
                        onPress={() => revisitHistoryItem(item)}
                      >
                        <View style={styles.historyItemInfo}>
                          <Text style={styles.historyItemTime}>{item.timestamp}</Text>
                          <Text style={styles.historyItemText} numberOfLines={2}>
                            {item.recognizedText}
                          </Text>
                          <Text style={styles.historyItemSongs}>
                            {item.results.length} result(s)
                          </Text>
                        </View>
                        <Text style={styles.historyItemArrow}>›</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.historyDeleteBtn}
                        onPress={() => deleteHistoryItem(item.id)}
                      >
                        <Text style={styles.historyDeleteIcon}>🗑️</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                />
                <TouchableOpacity
                  style={styles.clearHistoryBtn}
                  onPress={clearAllHistory}
                >
                  <Text style={styles.clearHistoryText}>Clear All History</Text>
                </TouchableOpacity>
              </>
            ) : (
              <View style={styles.emptyHistoryContainer}>
                <Text style={styles.emptyHistoryIcon}>📭</Text>
                <Text style={styles.emptyHistoryText}>No search history yet</Text>
              </View>
            )}
          </View>
        </SafeAreaView>
      </Modal>

      {/* Song Player Modal (FR-11) */}
      <Modal
        visible={showPlayer}
        transparent
        animationType="slide"
        onRequestClose={closePlayer}
      >
        <View style={styles.playerModalContainer}>
          <View style={styles.playerContent}>
            <TouchableOpacity style={styles.playerCloseBtn} onPress={closePlayer}>
              <Text style={styles.playerCloseText}>✕</Text>
            </TouchableOpacity>

            <Image 
              source={{ uri: activeSong?.album_art || 'https://via.placeholder.com/200' }} 
              style={styles.playerAlbumArt} 
            />
            
            <Text style={styles.playerTitle} numberOfLines={1}>{activeSong?.title}</Text>
            <Text style={styles.playerArtist}>{activeSong?.artist}</Text>

            {/* Playback Controls (FR-11 requirements) */}
            <View style={styles.playbackControls}>
              <TouchableOpacity onPress={resetToStart} style={styles.controlBtn}>
                <Text style={styles.controlIcon}>⏮️</Text>
                <Text style={styles.controlLabel}>Reset</Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={skipBackward} style={styles.controlBtn}>
                <Text style={styles.controlIcon}>⏪</Text>
                <Text style={styles.controlLabel}>-10s</Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={togglePlayback} style={[styles.controlBtn, styles.playPauseBtn]}>
                <Text style={styles.playPauseIcon}>{isPlaying ? '⏸️' : '▶️'}</Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={skipForward} style={styles.controlBtn}>
                <Text style={styles.controlIcon}>⏩</Text>
                <Text style={styles.controlLabel}>+10s</Text>
              </TouchableOpacity>
            </View>

            {/* Official Links */}
            <View style={styles.linksContainer}>
              <TouchableOpacity 
                style={[styles.linkBtn, { backgroundColor: '#1DB954' }]}
                onPress={() => activeSong?.external_url && window.open(activeSong.external_url, '_blank')}
              >
                <Text style={styles.linkText}>Spotify</Text>
              </TouchableOpacity>
              
              <TouchableOpacity 
                style={[styles.linkBtn, { backgroundColor: '#FF0000' }]}
                onPress={() => window.open(`https://www.youtube.com/results?search_query=${activeSong?.artist}+${activeSong?.title}`, '_blank')}
              >
                <Text style={styles.linkText}>YouTube</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // Main Container
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  scrollContainer: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingVertical: 20,
    paddingHorizontal: 20,
  },

  // Header
  header: {
    alignItems: 'center',
    marginBottom: 20,
    marginTop: 10,
  },
  title: {
    fontSize: 36,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
    letterSpacing: 0.5,
  },

  // History Button
  historyButton: {
    backgroundColor: COLORS.glassLight,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 20,
    marginBottom: 15,
    alignSelf: 'flex-end',
    borderWidth: 1,
    borderColor: 'rgba(124,58,237,0.3)',
  },
  historyButtonText: {
    color: COLORS.accentPurple,
    fontSize: 13,
    fontWeight: '600',
  },

  // Error Container - Glassmorphic
  errorContainer: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.accentRed,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,71,87,0.2)',
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,71,87,0.1)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,71,87,0.1)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  errorContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  errorIcon: {
    fontSize: 20,
  },
  errorText: {
    flex: 1,
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '500',
  },
  errorClose: {
    padding: 8,
  },
  closeIcon: {
    fontSize: 18,
    color: COLORS.accentRed,
    fontWeight: 'bold',
  },

  // Main Content
  mainContent: {
    alignItems: 'center',
    marginBottom: 30,
  },

  // Icon Container - Animated
  iconContainer: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: COLORS.glassLight,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 30,
    borderWidth: 2,
    borderColor: 'rgba(124,58,237,0.3)',
    position: 'relative',
    boxShadow: '0px 0px 20px rgba(124,58,237,0.3)',
    elevation: 5,
  },
  iconContainerRecording: {
    borderColor: COLORS.accentRed,
    backgroundColor: 'rgba(255,71,87,0.1)',
    boxShadow: '0px 0px 20px rgba(255,71,87,0.6)',
  },
  recordingGlow: {
    position: 'absolute',
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 2,
    borderColor: COLORS.accentRed,
    opacity: 0.3,
  },
  iconText: {
    fontSize: 60,
  },

  // Status Container
  statusContainer: {
    alignItems: 'center',
    marginBottom: 25,
  },
  statusHeading: {
    fontSize: 22,
    fontWeight: '600',
    color: COLORS.text,
    marginBottom: 8,
  },
  statusSubtitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
    letterSpacing: 0.3,
  },

  // Recording Indicator Dots
  recordingIndicator: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 25,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.accentRed,
    opacity: 0.4,
  },
  dotActive: {
    opacity: 0.8,
  },

  // Loading Container
  loadingContainer: {
    alignItems: 'center',
    marginBottom: 25,
  },
  spinnerWrapper: {
    marginBottom: 16,
  },
  loadingText: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
    marginBottom: 4,
  },
  loadingSubtext: {
    fontSize: 12,
    color: COLORS.textSecondary,
  },

  // Record Button
  recordButtonWrapper: {
    width: '100%',
    maxWidth: 280,
  },
  recordButton: {
    backgroundColor: COLORS.accentBlue,
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 50,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'rgba(59,130,246,0.5)',
    boxShadow: '0px 8px 16px rgba(59,130,246,0.4)',
    elevation: 8,
  },
  recordButtonActive: {
    backgroundColor: COLORS.accentRed,
    borderColor: 'rgba(255,71,87,0.5)',
    boxShadow: '0px 8px 16px rgba(255,71,87,0.4)',
  },
  recordButtonText: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  // Recognized Text Container
  recognizedTextContainer: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 16,
    marginBottom: 15,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.accentBlue,
    borderTopWidth: 1,
    borderTopColor: 'rgba(59,130,246,0.2)',
  },
  recognizedTextLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.accentBlue,
    marginBottom: 8,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  recognizedTextContent: {
    fontSize: 14,
    color: COLORS.text,
    lineHeight: 22,
    fontStyle: 'italic',
  },

  // Results List Container
  resultsListContainer: {
    marginTop: 10,
    marginBottom: 30,
  },
  resultsHeader: {
    marginBottom: 16,
  },
  resultsTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.accentGreen,
    letterSpacing: 0.5,
  },

  // Result Card
  resultCard: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 12,
    marginBottom: 12,
    flexDirection: 'row',
    gap: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
  },
  resultCardSelected: {
    borderColor: COLORS.accentBlue,
    backgroundColor: 'rgba(59,130,246,0.1)',
  },
  resultAlbumArt: {
    width: 70,
    height: 70,
    borderRadius: 8,
    backgroundColor: COLORS.glassLighter,
  },
  resultAlbumArtPlaceholder: {
    width: 70,
    height: 70,
    borderRadius: 8,
    backgroundColor: COLORS.glassLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderIcon: {
    fontSize: 32,
  },
  resultInfo: {
    flex: 1,
  },
  resultTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  resultNumber: {
    fontSize: 11,
    color: COLORS.textSecondary,
    fontWeight: '600',
  },
  resultConfidence: {
    fontSize: 11,
    color: COLORS.accentGreen,
    fontWeight: '700',
    backgroundColor: 'rgba(38,222,129,0.2)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  resultSongTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 2,
  },
  resultSongArtist: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginBottom: 4,
  },
  resultSource: {
    fontSize: 10,
    color: COLORS.accentPurple,
    fontWeight: '500',
  },
  resultArrow: {
    fontSize: 28,
    color: COLORS.accentBlue,
    fontWeight: '300',
  },

  // Action Buttons
  actionButtonsContainer: {
    gap: 12,
    marginTop: 16,
  },
  actionButton: {
    backgroundColor: COLORS.glassLight,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 50,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.4)',
  },
  actionButtonText: {
    color: COLORS.accentBlue,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  // Modal Container
  modalContainer: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  modalContent: {
    flex: 1,
    paddingHorizontal: 20,
    paddingVertical: 15,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
    paddingBottom: 15,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  modalTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: COLORS.text,
  },
  modalClose: {
    fontSize: 24,
    color: COLORS.textSecondary,
    fontWeight: 'bold',
  },

  // History Item
  historyItem: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
  },
  historyItemContent: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  historyItemInfo: {
    flex: 1,
  },
  historyItemTime: {
    fontSize: 11,
    color: COLORS.textSecondary,
    marginBottom: 4,
  },
  historyItemText: {
    fontSize: 13,
    color: COLORS.text,
    marginBottom: 4,
    fontWeight: '500',
  },
  historyItemSongs: {
    fontSize: 10,
    color: COLORS.accentGreen,
    fontWeight: '600',
  },
  historyItemArrow: {
    fontSize: 20,
    color: COLORS.accentBlue,
    marginHorizontal: 8,
  },
  historyDeleteBtn: {
    padding: 12,
    paddingRight: 16,
  },
  historyDeleteIcon: {
    fontSize: 18,
  },

  // Empty History
  emptyHistoryContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyHistoryIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyHistoryText: {
    fontSize: 14,
    color: COLORS.textSecondary,
    fontWeight: '500',
  },

  // Clear History Button
  clearHistoryBtn: {
    backgroundColor: COLORS.accentRed,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 50,
    alignItems: 'center',
    marginTop: 16,
  },
  clearHistoryText: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  // Recent History (Home Screen)
  recentHistoryContainer: {
    width: '100%',
    marginTop: 30,
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  recentHistoryTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.accentPurple,
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  recentHistoryItem: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  recentHistoryItemContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  recentHistoryItemText: {
    flex: 1,
    color: COLORS.text,
    fontSize: 14,
    marginRight: 10,
  },
  recentHistoryItemTime: {
    color: COLORS.textSecondary,
    fontSize: 10,
  },
  seeAllButton: {
    marginTop: 15,
    alignItems: 'center',
    paddingVertical: 8,
  },
  seeAllButtonText: {
    color: COLORS.accentBlue,
    fontSize: 13,
    fontWeight: '600',
  },

  // Language Toggle
  languageToggleContainer: {
    flexDirection: 'row',
    backgroundColor: COLORS.card,
    borderRadius: 20,
    padding: 4,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  languageOption: {
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 16,
  },
  languageOptionActive: {
    backgroundColor: COLORS.accentPurple,
  },
  languageOptionText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  languageOptionTextActive: {
    color: COLORS.text,
  },

  // Results Update
  resultItemWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  previewPlayBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLORS.accentBlue,
    justifyContent: 'center',
    alignItems: 'center',
    boxShadow: '0px 4px 8px rgba(59,130,246,0.3)',
    elevation: 4,
  },
  previewPlayIcon: {
    fontSize: 18,
  },

  // Player Modal
  playerModalContainer: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'flex-end',
  },
  playerContent: {
    backgroundColor: COLORS.background,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    padding: 30,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  playerCloseBtn: {
    alignSelf: 'flex-end',
    padding: 10,
  },
  playerCloseText: {
    color: COLORS.textSecondary,
    fontSize: 20,
    fontWeight: 'bold',
  },
  playerAlbumArt: {
    width: 200,
    height: 200,
    borderRadius: 20,
    marginBottom: 20,
    boxShadow: '0px 10px 20px rgba(0,0,0,0.5)',
  },
  playerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 4,
  },
  playerArtist: {
    fontSize: 16,
    color: COLORS.accentPurple,
    marginBottom: 30,
  },
  playbackControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 25,
    marginBottom: 40,
  },
  controlBtn: {
    alignItems: 'center',
  },
  controlIcon: {
    fontSize: 24,
    marginBottom: 4,
  },
  controlLabel: {
    fontSize: 10,
    color: COLORS.textSecondary,
    textTransform: 'uppercase',
  },
  playPauseBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: COLORS.accentBlue,
    justifyContent: 'center',
    alignItems: 'center',
  },
  playPauseIcon: {
    fontSize: 32,
  },
  linksContainer: {
    flexDirection: 'row',
    gap: 15,
    width: '100%',
  },
  linkBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  linkText: {
    color: COLORS.text,
    fontWeight: '700',
  },
});
