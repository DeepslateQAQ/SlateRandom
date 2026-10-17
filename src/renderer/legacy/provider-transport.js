(function (root) {
  'use strict';

  async function readBoundedBody(response, { maxBytes, signal } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new TypeError('maxBytes must be a non-negative safe integer');
    }
    let reader;
    let onAbort;
    let interrupted;
    const abortReason = () => signal.reason === undefined
      ? new DOMException('The operation was aborted.', 'AbortError')
      : signal.reason;
    const tooLarge = () => {
      const error = new Error('Response body exceeds the byte limit.');
      error.code = 'BODY_TOO_LARGE';
      return error;
    };
    try {
      if (response.body) reader = response.body.getReader();
      if (signal) {
        interrupted = new Promise((resolve, reject) => {
          onAbort = () => reject(abortReason());
          signal.addEventListener('abort', onAbort, { once: true });
        });
        // An already-aborted signal or early header rejection can precede a read race.
        interrupted.catch(() => {});
        if (signal.aborted) throw abortReason();
      }
      const contentLength = response.headers.get('content-length');
      if (contentLength !== null && /^\d+$/.test(contentLength.trim())
        && Number(contentLength) > maxBytes) {
        throw tooLarge();
      }
      if (!reader) return new Uint8Array(0);
      const chunks = [];
      let total = 0;
      for (;;) {
        const pending = reader.read();
        const { done, value } = await (interrupted ? Promise.race([pending, interrupted]) : pending);
        if (signal && signal.aborted) throw abortReason();
        if (done) break;
        if (value.byteLength > maxBytes - total) throw tooLarge();
        total += value.byteLength;
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } catch (error) {
      if (reader) {
        try {
          // Some fetch implementations never settle cancellation; do not wait for them.
          Promise.resolve(reader.cancel(error)).catch(() => {});
        } catch (_) {}
      }
      throw error;
    } finally {
      if (onAbort) {
        try { signal.removeEventListener('abort', onAbort); } catch (_) {}
      }
      if (reader) {
        try { reader.releaseLock(); } catch (_) {}
      }
    }
  }

  root.ProviderTransport = { readBoundedBody };
})(window);
