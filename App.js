/**
 * Audio Recorder & Song Identification App
 * Expo SDK 54
 * 
 * Features:
 * - Microphone permission request
 * - Audio recording with expo-av
 * - Song identification via AudD API
 * - Fun facts via Groq AI
 */

import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  SafeAreaView,
  ScrollView,
  Image,
  Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Audio from 'expo-av';
import * as FileSystem from 'expo-file-system';
import axios from 'axios';

// API Configuration
const AUDD_API_KEY = process.env.EXPO_PUBLIC_AUDD_API_KEY || 'your_audd_api_key_here';
const GROQ_API_KEY = process.env.EXPO_PUBLIC_GROQ_API_KEY || 'your_groq_api_key_here';

const AUDD_API_URL = 'https://api.audd.io/';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

export default function App() {
  const [recording, setRecording] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isGettingFacts, setIsGettingFacts] = useState(false);
  const [error, setError] = useState(null);
  const [recognizedSong, setRecognizedSong] = useState(null);
  const [groqResponse, setGroqResponse] = useState(null);
  const [mediaRecorder, setMediaRecorder] = useState(null);
  const [audioChunks, setAudioChunks] = useState([]);

  useEffect(() => {
    requestPermissions();
  }, []);

  const requestPermissions = async () => {
    try {
      if (Platform.OS === 'web') {
        // Web: request microphone access
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Stop the stream immediately, we'll request it again when recording
        stream.getTracks().forEach(track => track.stop());
      } else {
        // Android: request Audio recording permission
        const { status } = await Audio.requestRecordingPermissionsAsync();
        if (status === 'granted') {
          await Audio.setAudioModeAsync({
            allowsRecordingIOS: true,
            playsInSilentModeIOS: true,
          });
        } else {
          setError('Microphone permission is required. Please enable it in device settings.');
        }
      }
    } catch (err) {
      setError(`Failed to request microphone permission: ${err.message}`);
    }
  };

  const startRecording = async () => {
    try {
      setError(null);
      setRecognizedSong(null);
      setGroqResponse(null);

      if (Platform.OS === 'web') {
        // Web: use MediaRecorder API
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        const chunks = [];

        recorder.ondataavailable = (event) => {
          chunks.push(event.data);
        };

        recorder.onstop = async () => {
          const audioBlob = new Blob(chunks, { type: 'audio/webm' });
          setAudioChunks(chunks);

          // Convert blob to base64 for easier handling
          const reader = new FileReader();
          reader.onloadend = async () => {
            await analyzeWebAudio(audioBlob, reader.result);
          };
          reader.readAsDataURL(audioBlob);

          // Stop all tracks
          stream.getTracks().forEach(track => track.stop());
        };

        recorder.start();
        setMediaRecorder(recorder);
        setIsRecording(true);
      } else {
        // Android: use expo-av
        if (recording) {
          await recording.stop();
        }

        const { recording: newRecording } = await Audio.Recording.createAsync(
          Audio.RecordingOptionsPresets.HIGH_QUALITY
        );

        setRecording(newRecording);
        setIsRecording(true);
      }
    } catch (err) {
      setError(`Failed to start recording: ${err.message}`);
      setIsRecording(false);
    }
  };

  const stopRecording = async () => {
    try {
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
      setError(`Error during recording/analysis: ${err.message}`);
      setIsAnalyzing(false);
    }
  };

  const analyzeWebAudio = async (audioBlob, base64Data) => {
    try {
      const formData = new FormData();
      formData.append('file', audioBlob, 'recording.webm');
      formData.append('api_token', AUDD_API_KEY);
      formData.append('return', 'apple_music,spotify');

      const response = await axios.post(AUDD_API_URL, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        timeout: 60000,
      });

      const song = extractSongInfo(response.data);
      if (song) {
        setRecognizedSong(song);
        await getFunFactFromGroq(song);
      } else {
        setError('No song could be identified. Please try again with clearer audio.');
      }
      setIsAnalyzing(false);
    } catch (err) {
      console.error('AudD API error:', err);
      setError(`AudD API request failed: ${err.message}`);
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
        type: 'audio/mp4',
        name: fileName,
      });
      formData.append('api_token', AUDD_API_KEY);
      formData.append('return', 'apple_music,spotify');

      const response = await axios.post(AUDD_API_URL, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        timeout: 60000,
      });

      const song = extractSongInfo(response.data);
      if (song) {
        setRecognizedSong(song);
        await getFunFactFromGroq(song);
      } else {
        setError('No song could be identified. Please try again with clearer audio.');
      }
      setIsAnalyzing(false);
    } catch (err) {
      console.error('AudD API error:', err);
      setError(`AudD API request failed: ${err.message}`);
      setIsAnalyzing(false);
    }
  };

  const extractSongInfo = (response) => {
    try {
      if (response?.status === 'success' && response?.result) {
        const result = response.result;
        return {
          title: result.title || 'Unknown',
          artist: result.artist || 'Unknown Artist',
          album: result.album || 'Unknown',
          album_art: result.album_art || null,
          release_date: result.release_date || null,
        };
      }
      return null;
    } catch (err) {
      return null;
    }
  };

  const getFunFactFromGroq = async (song) => {
    try {
      setIsGettingFacts(true);

      const prompt = `Tell me an interesting fun fact or background story about the song "${song.title}" by "${song.artist}". Keep it concise (2-4 sentences) and engaging. If no specific fun fact is available, mention something general about the artist or the era the song was popular.`;

      const response = await axios.post(
        GROQ_API_URL,
        {
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7,
          max_tokens: 200,
        },
        {
          headers: {
            'Authorization': `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      setGroqResponse(response.data.choices[0].message.content.trim());
    } catch (err) {
      setGroqResponse('Unable to retrieve fun fact at this time.');
    } finally {
      setIsGettingFacts(false);
    }
  };

  const resetApp = () => {
    setRecording(null);
    setIsRecording(false);
    setIsAnalyzing(false);
    setRecognizedSong(null);
    setGroqResponse(null);
    setError(null);
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.scrollContainer} contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <Text style={styles.title}>🎵 Song Identifier</Text>
          <Text style={styles.subtitle}>Record & Discover Music</Text>
        </View>

        {error && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>⚠️ {error}</Text>
            <TouchableOpacity style={styles.retryButton} onPress={requestPermissions}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.mainContent}>
          <View style={styles.iconContainer}>
            <Text style={styles.iconText}>{isRecording ? '🔴' : '🎤'}</Text>
          </View>

          {!isRecording && !recognizedSong && (
            <>
              <Text style={styles.headerText}>Tap Record to Start</Text>
              <Text style={styles.subtitleText}>Record a snippet of any song you hear</Text>
            </>
          )}

          {isRecording && (
            <>
              <Text style={styles.headerText}>Recording in Progress</Text>
              <Text style={styles.subtitleText}>Tap "Stop & Analyze" when done</Text>
              <View style={styles.timerContainer}>
                <ActivityIndicator size="large" color="#ff4444" />
                <Text style={styles.timerText}>Recording...</Text>
              </View>
            </>
          )}

          {isAnalyzing && (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#4444ff" />
              <Text style={styles.loadingText}>Identifying song...</Text>
            </View>
          )}

          {!recognizedSong && !isAnalyzing && (
            <TouchableOpacity
              style={[styles.recordButton, isRecording && styles.recordButtonActive]}
              onPress={isRecording ? stopRecording : startRecording}
              disabled={isAnalyzing}
            >
              <Text style={styles.recordButtonText}>
                {isRecording ? 'Stop & Analyze' : 'Start Recording'}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {recognizedSong && (
          <View style={styles.resultsContainer}>
            <Text style={styles.resultLabel}>🎵 Recognized Song:</Text>
            
            {recognizedSong.album_art && (
              <Image source={{ uri: recognizedSong.album_art }} style={styles.albumArt} />
            )}
            
            <Text style={styles.resultTitle}>{recognizedSong.title}</Text>
            <Text style={styles.resultArtist}>by {recognizedSong.artist}</Text>
            {recognizedSong.album && recognizedSong.album !== 'Unknown' && (
              <Text style={styles.resultAlbum}>Album: {recognizedSong.album}</Text>
            )}

            <View style={styles.factContainer}>
              <Text style={styles.factLabel}>💡 Fun Fact:</Text>
              {isGettingFacts ? (
                <ActivityIndicator size="small" color="#4444ff" />
              ) : (
                <Text style={styles.factText}>{groqResponse || 'No fun fact available.'}</Text>
              )}
            </View>

            <TouchableOpacity style={styles.replayButton} onPress={resetApp}>
              <Text style={styles.replayText}>Record Another Song</Text>
            </TouchableOpacity>
          </View>
        )}

        <StatusBar style="auto" />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  scrollContainer: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    paddingVertical: 20,
  },
  header: {
    alignItems: 'center',
    marginBottom: 30,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#ffffff',
    marginTop: 10,
  },
  subtitle: {
    fontSize: 16,
    color: '#a0a0a0',
    marginTop: 5,
  },
  errorContainer: {
    backgroundColor: '#ff444422',
    borderRadius: 10,
    padding: 15,
    marginHorizontal: 20,
    marginBottom: 20,
    alignItems: 'center',
  },
  errorText: {
    color: '#ff6b6b',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 10,
  },
  retryButton: {
    backgroundColor: '#ff4444',
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 20,
  },
  retryText: {
    color: '#ffffff',
    fontWeight: 'bold',
  },
  mainContent: {
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  iconContainer: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#16213e',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
    borderWidth: 3,
    borderColor: '#0f3460',
  },
  iconText: {
    fontSize: 60,
  },
  headerText: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#ffffff',
    textAlign: 'center',
    marginBottom: 10,
  },
  subtitleText: {
    fontSize: 16,
    color: '#a0a0a0',
    textAlign: 'center',
    marginBottom: 20,
  },
  timerContainer: {
    alignItems: 'center',
    marginBottom: 20,
  },
  timerText: {
    color: '#ff4444',
    fontSize: 16,
    marginTop: 10,
  },
  loadingContainer: {
    alignItems: 'center',
    marginBottom: 20,
  },
  loadingText: {
    color: '#4444ff',
    fontSize: 16,
    marginTop: 10,
  },
  recordButton: {
    backgroundColor: '#e94560',
    paddingHorizontal: 40,
    paddingVertical: 18,
    borderRadius: 30,
    minWidth: 200,
    alignItems: 'center',
  },
  recordButtonActive: {
    backgroundColor: '#ff4444',
  },
  recordButtonText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  resultsContainer: {
    backgroundColor: '#16213e',
    borderRadius: 20,
    padding: 20,
    marginHorizontal: 20,
    marginTop: 20,
    alignItems: 'center',
    width: '100%',
    maxWidth: 400,
  },
  resultLabel: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#ffffff',
    marginBottom: 15,
  },
  albumArt: {
    width: 200,
    height: 200,
    borderRadius: 10,
    marginBottom: 15,
    backgroundColor: '#0f3460',
  },
  resultTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#ffffff',
    textAlign: 'center',
    marginBottom: 5,
  },
  resultArtist: {
    fontSize: 18,
    color: '#a0a0a0',
    marginBottom: 10,
    textAlign: 'center',
  },
  resultAlbum: {
    fontSize: 14,
    color: '#666666',
    marginBottom: 15,
  },
  factContainer: {
    backgroundColor: '#0f3460',
    borderRadius: 15,
    padding: 15,
    width: '100%',
    marginBottom: 15,
  },
  factLabel: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#4444ff',
    marginBottom: 8,
  },
  factText: {
    fontSize: 14,
    color: '#e0e0e0',
    lineHeight: 22,
  },
  replayButton: {
    backgroundColor: '#0f3460',
    paddingHorizontal: 30,
    paddingVertical: 12,
    borderRadius: 25,
    marginTop: 10,
  },
  replayText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: 'bold',
  },
});