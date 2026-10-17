/**
 * Voice: dictation into the message box and reading replies aloud. With the
 * "browser" engines nothing leaves the browser for Claudia's server (the
 * Web Speech API may use the browser vendor's service); with "server" the
 * recording or text goes to the admin's speech endpoints via /api/audio.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetchRaw, toApiError } from '../api/http';
import { errorMessage } from '../api/rtk-api';

type Mode = 'none' | 'browser' | 'server';

const MicIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);
const SpeakerIcon = ({ on }: { on: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 9v6h4l5 4V5L8 9H4z" />
    {on ? <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" /> : <path d="M16 10l4 4M20 10l-4 4" />}
  </svg>
);

/** Markdown → something pleasant to listen to. */
export function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\d{1,3}\]/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type Recognition = { start(): void; stop(): void; onresult: (e: any) => void; onend: () => void; onerror: (e: any) => void; continuous: boolean; interimResults: boolean; lang: string };

function browserRecognition(): Recognition | null {
  const Ctor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  return Ctor ? (new Ctor() as Recognition) : null;
}

/** Dictate into the message box. */
export function MicButton({ mode, onText, disabled }: { mode: Mode; onText: (text: string) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []);
  const supported = mode === 'browser' ? !!browserRecognition() : mode === 'server' ? typeof MediaRecorder !== 'undefined' : false;
  if (!supported) return null;

  const start = async () => {
    setError(null);
    if (mode === 'browser') {
      const rec = browserRecognition()!;
      rec.continuous = true;
      rec.interimResults = false;
      rec.lang = navigator.language;
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) onText(e.results[i][0].transcript.trim());
      };
      rec.onerror = (e) => setError(e.error === 'not-allowed' ? t('voice.micDenied') : String(e.error));
      rec.onend = () => setListening(false);
      rec.start();
      stopRef.current = () => rec.stop();
      setListening(true);
      return;
    }
    // Server: record, then transcribe
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError(t('voice.micDenied'));
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((tr) => tr.stop());
      setListening(false);
      setBusy(true);
      try {
        const form = new FormData();
        form.append('file', new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }), 'recording.webm');
        const res = await apiFetchRaw('/api/audio/transcriptions', { method: 'POST', body: form });
        if (!res.ok) throw await toApiError(res);
        const { text } = await res.json();
        if (text) onText(text);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    };
    recorder.start();
    stopRef.current = () => recorder.state !== 'inactive' && recorder.stop();
    setListening(true);
  };

  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => (listening ? stopRef.current?.() : void start())}
        disabled={disabled || busy}
        aria-pressed={listening}
        aria-label={listening ? t('voice.stopDictation') : t('voice.dictate')}
        title={error ?? (listening ? t('voice.stopDictation') : t('voice.dictate'))}
        className={`rounded p-1.5 transition-colors disabled:opacity-50 ${listening ? 'animate-pulse text-error' : error ? 'text-error' : 'text-text-secondary hover:bg-surface hover:text-accent'}`}
        data-testid="mic-button"
      >
        <MicIcon />
      </button>
    </span>
  );
}

let current: { stop: () => void } | null = null;

/** Read a reply aloud (one at a time). */
export function ReadAloudButton({ mode, text }: { mode: Mode; text: string }) {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = mode === 'browser' ? typeof window !== 'undefined' && 'speechSynthesis' in window : mode === 'server';
  if (!supported || !text.trim()) return null;

  const stop = () => {
    current?.stop();
    current = null;
    setPlaying(false);
  };
  const play = async () => {
    current?.stop();
    setError(null);
    const words = speakable(text);
    if (mode === 'browser') {
      const u = new SpeechSynthesisUtterance(words);
      u.lang = navigator.language;
      u.onend = () => setPlaying(false);
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      current = { stop: () => speechSynthesis.cancel() };
      setPlaying(true);
      return;
    }
    try {
      setPlaying(true);
      const res = await apiFetchRaw('/api/audio/speech', { method: 'POST', json: { text: words.slice(0, 4096) } });
      if (!res.ok) throw await toApiError(res);
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audio.onended = () => {
        setPlaying(false);
        URL.revokeObjectURL(url);
      };
      current = {
        stop: () => {
          audio.pause();
          URL.revokeObjectURL(url);
        },
      };
      await audio.play();
    } catch (err) {
      setPlaying(false);
      setError(errorMessage(err));
    }
  };

  return (
    <button
      type="button"
      className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${error ? 'text-error' : 'text-text-secondary hover:text-accent'}`}
      onClick={() => (playing ? stop() : void play())}
      aria-pressed={playing}
      title={error ?? (playing ? t('voice.stopReading') : t('voice.readAloud'))}
      data-testid="read-aloud"
    >
      <SpeakerIcon on={!playing} />
      {playing ? t('voice.stopReading') : t('voice.readAloud')}
    </button>
  );
}
