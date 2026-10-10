export async function retryDownload(operation, { attempts = 4,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.warn } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const retryable = error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error.name) ||
        error.status === 408 || error.status === 429 || error.status >= 500;
      if (!retryable || attempt >= attempts) throw error;
      const delay = Math.min(30000, 2000 * 2 ** (attempt - 1));
      log(`Download interrupted; retry ${attempt}/${attempts - 1} in ${delay / 1000}s...`);
      await wait(delay);
    }
  }
}
