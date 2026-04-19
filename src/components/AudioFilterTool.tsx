import { useState, useRef } from 'react';
import JSZip from 'jszip';

type FilterSpec = [BiquadFilterType, number, number | null, number?];

type Preset = {
  label: string;
  chain: FilterSpec[];
};

type FileEntry = {
  id: number;
  file: File;
  name: string;
};

type ResultEntry = {
  name: string;
  blob?: Blob;
  url: string | null;
  error: boolean;
};

type Status = {
  msg: string;
  kind: '' | 'success' | 'error';
};

const PRESETS: Record<string, Preset> = {
  'am-radio':       { label: 'AM Radio',                  chain: [['highpass', 200, 0.7], ['highpass', 200, 0.7], ['peaking', 1500, 1, 3], ['lowpass', 4500, 0.7], ['lowpass', 4500, 0.7]] },
  'telephone':      { label: 'Telephone',                 chain: [['highpass', 300, 0.7], ['highpass', 300, 0.7], ['peaking', 1200, 1.2, 2], ['lowpass', 3400, 0.7], ['lowpass', 3400, 0.7]] },
  'walkie-talkie':  { label: 'Walkie-talkie',             chain: [['highpass', 500, 0.7], ['highpass', 500, 0.7], ['peaking', 1500, 1.5, 6], ['lowpass', 3000, 0.7], ['lowpass', 3000, 0.7]] },
  'bass-boost':     { label: 'Bass boost',                chain: [['lowshelf', 200, null, 8]] },
  'bass-cut':       { label: 'Bass cut',                  chain: [['highpass', 150, 0.7]] },
  'treble-boost':   { label: 'Treble boost',              chain: [['highshelf', 4000, null, 8]] },
  'treble-cut':     { label: 'Treble cut',                chain: [['lowpass', 4000, 0.7]] },
  'rumble-remove':  { label: '100 Hz rumble removal',     chain: [['highpass', 100, 0.7], ['highpass', 100, 0.7]] },
  'speech-rolloff': { label: 'Low rolloff for speech',    chain: [['highpass', 100, 0.5]] },
  'muffled':        { label: 'Muffled (underwater)',      chain: [['lowpass', 800, 0.7], ['lowpass', 800, 0.7], ['lowshelf', 200, null, 4]] },
  'old-vinyl':      { label: 'Old vinyl',                 chain: [['highpass', 120, 0.7], ['peaking', 2500, 1, 2], ['lowpass', 6000, 0.7], ['highshelf', 8000, null, -6]] },
  'loudness':       { label: 'Loudness contour',          chain: [['lowshelf', 100, null, 6], ['highshelf', 6000, null, 4]] },
  'de-ess':         { label: 'De-ess (soften sibilance)', chain: [['peaking', 6500, 3, -6]] },
};

async function runChain(buffer: AudioBuffer, chainSpec: FilterSpec[]): Promise<AudioBuffer> {
  const off = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  const src = off.createBufferSource();
  src.buffer = buffer;
  let node: AudioNode = src;
  for (const [type, freq, q, gain] of chainSpec) {
    const f = off.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q !== null && q !== undefined) f.Q.value = q;
    if (gain !== null && gain !== undefined) f.gain.value = gain;
    node.connect(f);
    node = f;
  }
  node.connect(off.destination);
  src.start();
  return await off.startRendering();
}

function normalizeBuffer(buffer: AudioBuffer): AudioBuffer {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
  }
  if (peak > 1) {
    const gain = 0.98 / peak;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) data[i] *= gain;
    }
  }
  return buffer;
}

function bufferToWav(buffer: AudioBuffer): Blob {
  const numCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const len = buffer.length * numCh * 2 + 44;
  const ab = new ArrayBuffer(len);
  const v = new DataView(ab);
  const ws = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ws(0, 'RIFF'); v.setUint32(4, len - 8, true);
  ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, numCh, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * numCh * 2, true);
  v.setUint16(32, numCh * 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, len - 44, true);
  const chans: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

function formatSize(bytes: number): string {
  const kb = bytes / 1024;
  return kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`;
}

export default function AudioFilterTool() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [chain, setChain] = useState<string[]>([]);
  const [results, setResults] = useState<ResultEntry[]>([]);
  const [status, setStatus] = useState<Status>({ msg: 'Add files and filters to get started.', kind: '' });
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [normalize, setNormalize] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [presetValue, setPresetValue] = useState<string>('am-radio');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileIdRef = useRef(0);

  const canProcess = files.length > 0 && chain.length > 0 && !processing;

  const addFiles = (newFiles: File[]) => {
    const valid: FileEntry[] = [];
    for (const f of newFiles) {
      if (f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|m4a|aac|opus|wma|aiff?)$/i.test(f.name)) {
        valid.push({ id: ++fileIdRef.current, file: f, name: f.name });
      }
    }
    setFiles(prev => [...prev, ...valid]);
  };

  const removeFile = (id: number) => setFiles(prev => prev.filter(f => f.id !== id));

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  };

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(Array.from(e.target.files));
    e.target.value = '';
  };

  const addFilter = () => setChain(prev => [...prev, presetValue]);
  const removeFilter = (idx: number) => setChain(prev => prev.filter((_, i) => i !== idx));
  const moveFilter = (idx: number, dir: number) => {
    setChain(prev => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return next;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };
  const clearChain = () => setChain([]);

  const clearResults = () => {
    results.forEach(r => r.url && URL.revokeObjectURL(r.url));
    setResults([]);
    setStatus({ msg: 'Results cleared.', kind: '' });
  };

  const processAll = async () => {
    if (!canProcess) return;

    results.forEach(r => r.url && URL.revokeObjectURL(r.url));
    setResults([]);
    setProcessing(true);
    setProgress(0);

    const combinedChain = chain.flatMap(k => PRESETS[k].chain);
    const chainName = chain.join('_');
    const newResults: ResultEntry[] = [];
    let failed = 0;

    for (let i = 0; i < files.length; i++) {
      const entry = files[i];
      setStatus({ msg: `Processing ${i + 1}/${files.length}: ${entry.name}…`, kind: '' });
      try {
        const arr = await entry.file.arrayBuffer();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const buffer = await ctx.decodeAudioData(arr);
        ctx.close();
        const processed = await runChain(buffer, combinedChain);
        const finalBuf = normalize ? normalizeBuffer(processed) : processed;
        const wav = bufferToWav(finalBuf);
        const baseName = entry.name.replace(/\.[^.]+$/, '') || 'audio';
        const outName = `${baseName}_${chainName}.wav`;
        const url = URL.createObjectURL(wav);
        newResults.push({ name: outName, blob: wav, url, error: false });
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        newResults.push({ name: `${entry.name} — ${msg}`, url: null, error: true });
      }
      setProgress(((i + 1) / files.length) * 100);
    }

    setResults(newResults);
    setProcessing(false);
    const successCount = newResults.filter(r => !r.error).length;
    if (failed === 0) {
      setStatus({ msg: `Done. Processed ${successCount} file${successCount === 1 ? '' : 's'}.`, kind: 'success' });
    } else if (successCount > 0) {
      setStatus({ msg: `Processed ${successCount}, ${failed} failed.`, kind: 'error' });
    } else {
      setStatus({ msg: `All ${failed} file${failed === 1 ? '' : 's'} failed to process.`, kind: 'error' });
    }
  };

  const downloadZip = async () => {
    const valid = results.filter(r => !r.error && r.blob);
    if (!valid.length) return;
    setStatus({ msg: 'Building zip…', kind: '' });
    const zip = new JSZip();
    for (const r of valid) if (r.blob) zip.file(r.name, r.blob);
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'processed_audio.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus({ msg: `Zipped ${valid.length} files.`, kind: 'success' });
  };

  const statusClasses: Record<Status['kind'], string> = {
    '': 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400',
    'success': 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
    'error': 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  };

  const btnBase = 'px-4 py-2 rounded-lg border text-sm transition-colors';
  const btnSecondary = `${btnBase} border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-700`;
  const iconBtn = 'text-neutral-400 hover:text-neutral-900 dark:hover:text-white px-2 py-0.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed';
  const sectionLabel = 'text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-2';
  const rowItem = 'flex items-center gap-2 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm';
  const emptyBox = 'mt-2 border border-dashed border-neutral-200 dark:border-neutral-700 rounded-lg p-3 text-center text-sm text-neutral-400 italic';

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100">
      <div className="max-w-3xl mx-auto px-6 py-8 pb-24">
        <h1 className="text-2xl font-medium">Audio filter batch tool</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1 mb-7">
          Apply a chain of EQ presets to multiple audio files. Everything runs locally in your browser — files never leave your machine.
        </p>

        <section className="mb-6">
          <div className={sectionLabel}>1. Audio files</div>
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
              dragging
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
                : 'border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 hover:border-blue-500'
            }`}
          >
            <div className="text-[15px]">Drop audio files here, or click to choose</div>
            <div className="text-xs text-neutral-400 dark:text-neutral-500 mt-1">
              Multiple files supported. .wav, .mp3, .ogg, .flac, .m4a — anything your browser can decode.
            </div>
            <input ref={fileInputRef} type="file" accept="audio/*" multiple className="hidden" onChange={onFileInput} />
          </div>

          {files.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {files.map(f => (
                <li key={f.id} className={rowItem}>
                  <span className="flex-1 truncate">{f.name}</span>
                  <span className="text-xs text-neutral-400">{formatSize(f.file.size)}</span>
                  <button onClick={() => removeFile(f.id)} className={`${iconBtn} hover:!text-red-500`} title="Remove">✕</button>
                </li>
              ))}
            </ul>
          ) : (
            <div className={emptyBox}>No files added yet</div>
          )}
        </section>

        <section className="mb-6">
          <div className={sectionLabel}>2. Filter chain</div>
          <div className="flex gap-2 flex-wrap items-center">
            <select
              value={presetValue}
              onChange={(e) => setPresetValue(e.target.value)}
              className="px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm min-w-[240px] focus:outline-none focus:border-blue-500"
            >
              {Object.entries(PRESETS).map(([key, p]) => (
                <option key={key} value={key}>{p.label}</option>
              ))}
            </select>
            <button onClick={addFilter} className={btnSecondary}>+ Add filter</button>
            <button onClick={clearChain} className={btnSecondary}>Clear chain</button>
          </div>

          {chain.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {chain.map((key, idx) => (
                <li key={idx} className={rowItem}>
                  <span className="w-6 h-6 flex items-center justify-center bg-neutral-100 dark:bg-neutral-700 rounded-full text-xs font-medium">{idx + 1}</span>
                  <span className="flex-1">{PRESETS[key].label}</span>
                  <button onClick={() => moveFilter(idx, -1)} disabled={idx === 0} className={iconBtn} title="Move up">↑</button>
                  <button onClick={() => moveFilter(idx, 1)} disabled={idx === chain.length - 1} className={iconBtn} title="Move down">↓</button>
                  <button onClick={() => removeFilter(idx)} className={`${iconBtn} hover:!text-red-500`} title="Remove">✕</button>
                </li>
              ))}
            </ul>
          ) : (
            <div className={emptyBox}>Chain is empty — add at least one filter</div>
          )}
        </section>

        <section className="mb-6">
          <div className={sectionLabel}>3. Process</div>
          <div className="flex gap-3 items-center flex-wrap">
            <button
              onClick={processAll}
              disabled={!canProcess}
              className="px-5 py-2 rounded-lg bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 text-sm font-medium hover:bg-black dark:hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {processing ? 'Processing…' : 'Process all files'}
            </button>
            <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400 cursor-pointer">
              <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} className="rounded" />
              Normalize output (prevent clipping)
            </label>
          </div>
          <div className={`mt-3 px-3 py-2.5 rounded-lg text-sm min-h-[38px] flex items-center ${statusClasses[status.kind]}`}>
            {status.msg}
          </div>
          {processing && (
            <div className="mt-2 h-1 bg-neutral-200 dark:bg-neutral-700 rounded overflow-hidden">
              <div className="h-full bg-blue-500 transition-all duration-200" style={{ width: `${progress}%` }} />
            </div>
          )}
        </section>

        {results.length > 0 && (
          <section>
            <div className={sectionLabel}>Results</div>
            <ul className="space-y-1.5">
              {results.map((r, idx) => (
                <li key={idx} className={rowItem}>
                  <span className={`flex-1 truncate ${r.error ? 'text-red-600 dark:text-red-400' : ''}`}>{r.name}</span>
                  {r.url && (
                    <a href={r.url} download={r.name} className="px-3 py-1 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/50 dark:text-blue-300 dark:hover:bg-blue-950 text-xs font-medium no-underline">
                      Download
                    </a>
                  )}
                </li>
              ))}
            </ul>
            <div className="flex gap-2 mt-3 flex-wrap">
              <button onClick={downloadZip} className={btnSecondary}>Download all as zip</button>
              <button onClick={clearResults} className={btnSecondary}>Clear results</button>
            </div>
          </section>
        )}

        <footer className="mt-12 pt-5 border-t border-neutral-200 dark:border-neutral-700 text-xs text-neutral-400">
          Filters are biquad chains approximating Audacity's Filter Curve EQ presets. Output is 16-bit PCM WAV at the source sample rate.
        </footer>
      </div>
    </div>
  );
}
