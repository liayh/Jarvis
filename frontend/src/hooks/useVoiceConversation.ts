import { useCallback, useRef, useState } from 'react';
import { transcribeAudio } from '../lib/api';

export type VoiceConversationState =
  | 'off'
  | 'listening' // waiting to hear the wake word
  | 'capturing' // wake word heard, recording the actual question
  | 'thinking' // waiting for the chat reply
  | 'speaking'; // playing the TTS reply back

// Short Whisper segments frequently mangle "Jarvis" (observed: "j'avis",
// "javis"). Rather than one brittle regex, fuzzy-match each word in the
// transcript against "jarvis" by edit distance — tolerant of the small
// transcription slips a name outside Whisper's vocabulary tends to produce.
const WAKE_WORD = 'jarvis';
const WAKE_WORD_MAX_DISTANCE = 2;

function levenshtein(a: string, b: string): number {
  const dp: number[] = Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[b.length];
}

/** Find the wake word in a transcript. Returns the match info, or null. */
function findWakeWord(text: string): { start: number; end: number } | null {
  // Strip apostrophes so "j'avis" normalizes to "javis" before comparison.
  const normalized = text.replace(/['’]/g, '');
  const wordRe = /[\p{L}]+/gu;
  let match: RegExpExecArray | null;
  while ((match = wordRe.exec(normalized)) !== null) {
    const word = match[0].toLowerCase();
    if (word.length < 4) continue; // too short to meaningfully compare
    if (levenshtein(word, WAKE_WORD) <= WAKE_WORD_MAX_DISTANCE) {
      return { start: match.index, end: match.index + match[0].length };
    }
  }
  return null;
}

// Voice-activity thresholds. Tuned for a laptop mic in a normal room; a
// noisier environment may need a higher SPEECH_RMS_THRESHOLD.
const SPEECH_RMS_THRESHOLD = 0.02;
const SILENCE_HOLD_MS = 900; // how long below-threshold audio ends a segment
const MIN_SEGMENT_MS = 350; // ignore blips shorter than this (clicks, breath)
const MAX_SEGMENT_MS = 15000; // hard cap so a stuck-open mic can't record forever

interface UseVoiceConversationArgs {
  onQuery: (text: string) => void;
  isBusy: () => boolean; // true while the chat is streaming a reply
}

export function useVoiceConversation({ onQuery, isBusy }: UseVoiceConversationArgs) {
  const [state, setState] = useState<VoiceConversationState>('off');
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const speechStartedAtRef = useRef<number | null>(null);
  const lastLoudAtRef = useRef<number>(0);
  const modeRef = useRef<VoiceConversationState>('off');
  const suspendedRef = useRef(false); // true while 'thinking'/'speaking' — VAD ignores audio

  const setMode = useCallback((next: VoiceConversationState) => {
    modeRef.current = next;
    setState(next);
  }, []);

  const rms = useCallback((data: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return Math.sqrt(sum / data.length);
  }, []);

  const finalizeSegment = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;

    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    recorderRef.current = null;

    const durationMs = speechStartedAtRef.current
      ? Date.now() - speechStartedAtRef.current
      : 0;
    speechStartedAtRef.current = null;
    const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
    chunksRef.current = [];

    if (durationMs < MIN_SEGMENT_MS) return; // too short to be real speech

    let text = '';
    try {
      const result = await transcribeAudio(blob);
      text = (result.text || '').trim();
    } catch {
      return; // transcription hiccup — stay in the current mode and keep listening
    }
    if (!text) return;

    if (modeRef.current === 'listening') {
      const normalized = text.replace(/['’]/g, '');
      const match = findWakeWord(text);
      if (!match) return; // not the wake word — ignore and keep listening
      const after = normalized.slice(match.end).trim();
      if (after.length > 2) {
        // "Hey Jarvis, what time is it" said in one breath — use it directly.
        setMode('thinking');
        onQuery(after);
      } else {
        // Just the wake word — record the actual question next.
        setMode('capturing');
      }
      return;
    }

    if (modeRef.current === 'capturing') {
      setMode('thinking');
      onQuery(text);
    }
  }, [onQuery, setMode]);

  const startSegment = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    chunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.start();
    recorderRef.current = recorder;
    speechStartedAtRef.current = Date.now();
  }, []);

  const vadLoop = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Float32Array(analyser.fftSize);

    const tick = () => {
      analyser.getFloatTimeDomainData(data);
      const level = rms(data);
      const now = Date.now();

      if (!suspendedRef.current && modeRef.current !== 'off' && modeRef.current !== 'thinking' && modeRef.current !== 'speaking') {
        const isLoud = level > SPEECH_RMS_THRESHOLD;
        if (isLoud) lastLoudAtRef.current = now;

        if (isLoud && !recorderRef.current) {
          startSegment();
        } else if (recorderRef.current) {
          const silentFor = now - lastLoudAtRef.current;
          const segmentAge = speechStartedAtRef.current ? now - speechStartedAtRef.current : 0;
          if (silentFor > SILENCE_HOLD_MS || segmentAge > MAX_SEGMENT_MS) {
            void finalizeSegment();
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [finalizeSegment, rms, startSegment]);

  const start = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone not supported in this browser');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      lastLoudAtRef.current = Date.now();
      setMode('listening');
      vadLoop();
    } catch {
      setError('Microphone access denied');
    }
  }, [setMode, vadLoop]);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    recorderRef.current?.stop();
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
    setMode('off');
  }, [setMode]);

  // Call when the chat reply starts streaming — pauses VAD so Jarvis never
  // hears (and transcribes) its own voice.
  const notifyThinking = useCallback(() => {
    suspendedRef.current = true;
    setMode('thinking');
  }, [setMode]);

  // Call once the TTS reply audio element starts playing.
  const notifySpeaking = useCallback(() => {
    setMode('speaking');
  }, [setMode]);

  // Call once the TTS reply finishes (or voice replies are off) — resumes
  // wake-word listening.
  const notifyDone = useCallback(() => {
    suspendedRef.current = false;
    lastLoudAtRef.current = Date.now();
    if (modeRef.current !== 'off') setMode('listening');
  }, [setMode]);

  return {
    state,
    error,
    isBusyExternally: isBusy,
    start,
    stop,
    notifyThinking,
    notifySpeaking,
    notifyDone,
  };
}
