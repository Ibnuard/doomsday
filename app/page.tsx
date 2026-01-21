'use client';

import { useState } from 'react';

export default function Home() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [videos, setVideos] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [streamingUrl, setStreamingUrl] = useState<string | null>(null);

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
        setVideos(data.videos);
        setMessage(`Found ${data.videos.length} video(s)!`);
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

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 p-4 font-sans dark:bg-zinc-900">
      <main className="flex w-full max-w-2xl flex-col items-center gap-8 rounded-2xl bg-white p-8 shadow-xl dark:bg-zinc-800">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-zinc-900 dark:text-white">Video Grabber</h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">
            Enter a website URL to check for downloadable videos.
          </p>
        </div>

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
                <div className="flex gap-2">
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
