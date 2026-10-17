'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EdgeTTS } = require('node-edge-tts');

const VOICES = Object.freeze({
  '茉莉': 'zh-CN-XiaoxiaoNeural',
  '冰糖': 'zh-CN-YunxiNeural',
  '苏打': 'zh-CN-XiaoyiNeural',
  '白桦': 'zh-CN-YunjianNeural',
  mimo_default: 'zh-CN-XiaoxiaoNeural',
  Mia: 'en-US-MichelleNeural',
  Chloe: 'en-US-AvaNeural',
  Milo: 'en-US-AndrewNeural',
  Dean: 'en-US-BrianNeural'
});
const MAX_TEXT = 200;
const MAX_AUDIO = 16 * 1024 * 1024;

function createEdgeTtsService({ temporaryDirectory = os.tmpdir(), cacheDirectory = null, maxCacheBytes = 64 * 1024 * 1024, ttsFactory = options => new EdgeTTS(options) } = {}) {
  let queue = Promise.resolve(), cacheQueue = Promise.resolve(), cacheGeneration = 0;
  const flights = new Map();
  const cacheName = /^[a-f0-9]{64}\.bin$/;
  const temporaryCacheName = /^[a-f0-9]{64}\.[a-f0-9]{24}\.tmp$/;
  function checkGeneration(generation) {
    if (generation === cacheGeneration) return;
    const error = Error('姓名朗读已取消。'); error.name = 'AbortError'; throw error;
  }
  const digest = audio => crypto.createHash('sha256').update(audio).digest();
  function cacheOperation(action) {
    const task = cacheQueue.then(action);
    cacheQueue = task.catch(() => {});
    return task;
  }
  async function readCache(key) {
    if (!cacheDirectory) return null;
    const file = path.join(cacheDirectory, key + '.bin');
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.size <= 32 || info.size > MAX_AUDIO + 32 || info.size > maxCacheBytes) return null;
      const stored = await fs.readFile(file);
      if (stored.length <= 32 || stored.length > MAX_AUDIO + 32 || stored.length > maxCacheBytes) return null;
      const audio = stored.subarray(32);
      if (!digest(audio).equals(stored.subarray(0, 32))) return null;
      try { const now = new Date(); await fs.utimes(file, now, now); } catch { /* Cache touches never block playback. */ }
      return audio;
    } catch { return null; }
  }
  async function writeCache(key, audio, generation) {
    if (!cacheDirectory || audio.length + 32 > maxCacheBytes) return;
    return cacheOperation(async () => {
      if (generation !== cacheGeneration) return;
      const file = path.join(cacheDirectory, key + '.bin');
      const temporary = path.join(cacheDirectory, key + '.' + crypto.randomBytes(12).toString('hex') + '.tmp');
      try {
        await fs.mkdir(cacheDirectory, { recursive: true });
        await fs.writeFile(temporary, Buffer.concat([digest(audio), audio]), { flag: 'wx', mode: 0o600 });
        if (generation !== cacheGeneration) return;
        await fs.rename(temporary, file);
        const entries = [];
        for (const name of await fs.readdir(cacheDirectory)) {
          if (!cacheName.test(name)) continue;
          const location = path.join(cacheDirectory, name), info = await fs.lstat(location);
          if (info.isFile()) entries.push({ location, size: info.size, used: info.mtimeMs });
        }
        entries.sort((a, b) => a.used - b.used);
        let total = entries.reduce((sum, entry) => sum + entry.size, 0);
        for (const entry of entries) {
          if (total <= maxCacheBytes) break;
          await fs.rm(entry.location, { force: true }); total -= entry.size;
        }
      } catch { /* A read-only, full or damaged cache must not fail synthesis. */ }
      finally { try { await fs.rm(temporary, { force: true }); } catch {} }
    });
  }
  async function clearCache() {
    cacheGeneration++;
    flights.clear();
    await cacheOperation(async () => {
      if (!cacheDirectory) return;
      let names;
      try { names = await fs.readdir(cacheDirectory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const name of names) if (cacheName.test(name) || temporaryCacheName.test(name)) await fs.rm(path.join(cacheDirectory, name), { force: true });
    });
  }
  function cancelPending() { cacheGeneration++; flights.clear(); }
  async function synthesize(text, requestedVoice = '茉莉') {
    const value = String(text ?? '').trim();
    if (!value || value.length > MAX_TEXT || /[\u0000-\u001f\u007f]/.test(value)) throw Error('姓名文本无效。');
    const voice = Object.hasOwn(VOICES, requestedVoice) ? VOICES[requestedVoice] : VOICES['茉莉'];
    const options = { voice, lang: voice.startsWith('en-') ? 'en-US' : 'zh-CN', outputFormat: 'audio-24khz-48kbitrate-mono-mp3', rate: 'default', pitch: 'default', volume: 'default' };
    const key = crypto.createHash('sha256').update(JSON.stringify(['edge-tts-v1', value, options])).digest('hex');
    if (flights.has(key)) return flights.get(key);
    const generation = cacheGeneration;
    const result = (async () => {
      // Hits bypass the network queue, even while another name is synthesizing.
      const cached = await readCache(key);
      checkGeneration(generation);
      if (cached) return cached;
      const file = path.join(temporaryDirectory, 'slaterandom-tts-' + crypto.randomBytes(12).toString('hex') + '.mp3');
      const task = queue.then(async () => {
        checkGeneration(generation);
        try {
          const tts = ttsFactory({ ...options, timeout: 20000 });
          await tts.ttsPromise(value, file);
          checkGeneration(generation);
          const audio = await fs.readFile(file);
          if (!audio.length || audio.length > MAX_AUDIO) throw Error('语音服务返回的音频大小无效。');
          return audio;
        } catch (error) {
          if (typeof error === 'string') throw Error(error === 'Timed out' ? '语音合成超时。' : error);
          throw error;
        } finally {
          try { await fs.rm(file, { force: true }); } catch { /* The provider may still be releasing its stream. */ }
        }
      });
      queue = task.catch(() => {});
      const audio = await task;
      await writeCache(key, audio, generation);
      checkGeneration(generation);
      return audio;
    })();
    flights.set(key, result);
    try { return await result; }
    finally { if (flights.get(key) === result) flights.delete(key); }
  }
  return Object.freeze({ synthesize, clearCache, cancelPending });
}

module.exports = { createEdgeTtsService, VOICES };
