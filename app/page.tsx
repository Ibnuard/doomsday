'use client';

import { useState, useEffect } from 'react';

interface SavedVideo {
  url: string;
  sourceUrl: string;
  savedAt: string;
}

const STORAGE_KEY = 'doomsday_saved_videos';

export default function Home() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [videos, setVideos] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [streamingUrl, setStreamingUrl] = useState<string | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [savedVideos, setSavedVideos] = useState<SavedVideo[]>([]);
  const [showSavedVideos, setShowSavedVideos] = useState(false);

  // Load saved videos from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        setSavedVideos(JSON.parse(stored));
      } catch {
        console.error('Failed to parse saved videos');
      }
    }
  }, []);

  // Save to localStorage whenever savedVideos changes
  useEffect(() => {
    if (savedVideos.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(savedVideos));
    }
  }, [savedVideos]);

  const copyToClipboard = async (text: string, index: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const saveVideo = (videoUrl: string) => {
    const newSavedVideo: SavedVideo = {
      url: videoUrl,
      sourceUrl: url,
      savedAt: new Date().toISOString(),
    };
    
    // Check if already saved
    if (savedVideos.some(v => v.url === videoUrl)) {
      return;
    }
    
    setSavedVideos(prev => [...prev, newSavedVideo]);
  };

  const removeSavedVideo = (videoUrl: string) => {
    const updated = savedVideos.filter(v => v.url !== videoUrl);
    setSavedVideos(updated);
    if (updated.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  const clearUrl = () => {
    setUrl('');
    setVideos([]);
    setMessage('');
    setStreamingUrl(null);
  };

  const checkVideo = async () => {
    if (!url) return;
    setLoading(true);
    setMessage('');
    setVideos([]);
    setStreamingUrl(null);

    try {
      const res = await fetch('/api/check-video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      });

      const data = await res.json();

      if (data.success && data.videos && data.videos.length > 0) {
        // Deduplikasi URL
        const uniqueVideos = [...new Set<string>(data.videos)];
        setVideos(uniqueVideos);
        setMessage(`Found ${uniqueVideos.length} video(s)!`);
      } else if (data.success) {
        setMessage('No downloadable video found on this page.');
      } else {
        setMessage(data.message || 'Something went wrong.');
      }
    } catch (error) {
      setMessage('Failed to connect to the server.');
    } finally {
      setLoading(false);
    }
  };

  const isVideoSaved = (videoUrl: string) => savedVideos.some(v => v.url === videoUrl);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 p-4 font-sans dark:bg-zinc-900">
      <main className="flex w-full max-w-2xl flex-col items-center gap-8 rounded-2xl bg-white p-8 shadow-xl dark:bg-zinc-800">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-zinc-900 dark:text-white">Doomsday</h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">
            Enter a website URL to check for downloadable videos.
          </p>
          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
            v1.2.0 — Smart Click Loop + Save Videos
          </p>
        </div>

        {/* Saved Videos Button */}
        {savedVideos.length > 0 && (
          <button
            onClick={() => setShowSavedVideos(!showSavedVideos)}
            className="rounded-lg bg-amber-500 px-4 py-2 font-semibold text-white transition-colors hover:bg-amber-600"
          >
            📁 Saved Videos ({savedVideos.length}) {showSavedVideos ? '▲' : '▼'}
          </button>
        )}

        {/* Saved Videos List */}
        {showSavedVideos && savedVideos.length > 0 && (
          <div className="w-full rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-900/20">
            <h3 className="mb-3 font-semibold text-amber-800 dark:text-amber-400">Saved Videos</h3>
            <div className="flex flex-col gap-3">
              {savedVideos.map((saved, index) => (
                <div key={index} className="flex flex-col gap-2 rounded-lg bg-white p-3 dark:bg-zinc-800">
                  <div className="truncate text-xs text-zinc-500 dark:text-zinc-400" title={saved.sourceUrl}>
                    From: {saved.sourceUrl}
                  </div>
                  <div className="truncate text-sm text-zinc-700 dark:text-zinc-300" title={saved.url}>
                    {saved.url}
                  </div>
                  <div className="text-xs text-zinc-400">
                    Saved: {new Date(saved.savedAt).toLocaleString()}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => copyToClipboard(saved.url, 1000 + index)}
                      className="rounded-md bg-zinc-600 px-3 py-1 text-xs font-medium text-white hover:bg-zinc-700"
                    >
                      {copiedIndex === 1000 + index ? '✓ Tersalin!' : '📋 Salin'}
                    </button>
                    <button
                      onClick={() => setStreamingUrl(saved.url)}
                      className="rounded-md bg-purple-600 px-3 py-1 text-xs font-medium text-white hover:bg-purple-700"
                    >
                      ▶ Stream
                    </button>
                    <a
                      href={saved.url}
                      download
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-md bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700"
                    >
                      ⬇ Download
                    </a>
                    <button
                      onClick={() => removeSavedVideo(saved.url)}
                      className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
                    >
                      🗑 Hapus
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex w-full flex-col gap-4 sm:flex-row">
          <input
            type="url"
            placeholder="https://example.com/video-page"
            className="flex-1 rounded-lg border border-zinc-300 bg-zinc-50 px-4 py-3 text-zinc-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500 dark:border-zinc-600 dark:bg-zinc-700 dark:text-white dark:placeholder-zinc-400"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && checkVideo()}
          />
          <button
            onClick={checkVideo}
            disabled={loading}
            className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Checking...' : 'Check URL'}
          </button>
          {url && (
            <button
              onClick={clearUrl}
              className="rounded-lg bg-zinc-500 px-4 py-3 font-semibold text-white transition-colors hover:bg-zinc-600"
            >
              ✕ Clear
            </button>
          )}
        </div>

        {message && (
          <div className={`w-full rounded-lg p-4 text-center ${videos.length > 0 ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'}`}>
            {message}
          </div>
        )}

        {/* Video Player Modal */}
        {streamingUrl && (
          <div className="w-full rounded-xl border border-zinc-200 bg-black p-2 dark:border-zinc-700">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm text-white">Now Streaming</span>
              <button
                onClick={() => setStreamingUrl(null)}
                className="rounded px-2 py-1 text-sm text-white hover:bg-zinc-700"
              >
                ✕ Close
              </button>
            </div>
            <video
              src={streamingUrl}
              controls
              autoPlay
              className="w-full rounded-lg"
              style={{ maxHeight: '400px' }}
            >
              Your browser does not support the video tag.
            </video>
          </div>
        )}

        {videos.length > 0 && (
          <div className="flex w-full flex-col gap-4">
            {videos.map((videoUrl, index) => (
              <div key={index} className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800/50 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex-1 truncate text-sm text-zinc-600 dark:text-zinc-400" title={videoUrl}>
                  {videoUrl}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => saveVideo(videoUrl)}
                    disabled={isVideoSaved(videoUrl)}
                    className={`rounded-md px-4 py-2 text-sm font-medium text-white ${isVideoSaved(videoUrl) ? 'cursor-not-allowed bg-amber-400' : 'bg-amber-500 hover:bg-amber-600'}`}
                  >
                    {isVideoSaved(videoUrl) ? '✓ Tersimpan' : '💾 Simpan'}
                  </button>
                  <button
                    onClick={() => copyToClipboard(videoUrl, index)}
                    className="rounded-md bg-zinc-600 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
                  >
                    {copiedIndex === index ? '✓ Tersalin!' : '📋 Salin Link'}
                  </button>
                  <button
                    onClick={() => setStreamingUrl(videoUrl)}
                    className="rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700"
                  >
                    ▶ Stream
                  </button>
                  <a
                    href={videoUrl}
                    download
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
                  >
                    ⬇ Download
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
