import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';

const SENSITIVE_KEY = /token|password|passwd|cookie|secret|authorization|credential|csrf|accountscope/i;
const SENSITIVE_TEXT = /(?:bearer\s+[a-z0-9._~+/-]{8,}|\bsk-[a-z0-9_-]{8,}\b|saishi_agent_[A-Za-z0-9_-]{64})/giu;
const CREDENTIAL_URL = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/<>"'@]+@/giu;

export function sanitizeEvidence(value) {
  if (typeof value === 'string') return value.replace(SENSITIVE_TEXT, '[REDACTED]').replace(CREDENTIAL_URL, '$1[REDACTED]@');
  if (Array.isArray(value)) return value.map(sanitizeEvidence);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeEvidence(item)]));
  return value;
}

/** Retry only an observation of the same endpoint; never login, submit or replay a write. */
export async function requestCloudObservation(client, path, {
  signal, timeoutMs = 20_000, totalTimeoutMs = 30_000, deadline, maxAttempts = 3, onRecovery,
} = {}) {
  if (!client || typeof client.request !== 'function' || typeof path !== 'string' ||
      !path.startsWith('/') || path.startsWith('//') || path.startsWith('/api/') || path.includes('..') ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 650_000 ||
      !Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 100 || totalTimeoutMs > 650_000 ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5 ||
      (deadline !== undefined && !Number.isFinite(deadline)) || (onRecovery !== undefined && typeof onRecovery !== 'function')) {
    throw new Error('Invalid bounded cloud observation request.');
  }
  signal?.throwIfAborted();
  const began = performance.now();
  const until = Math.min(began + totalTimeoutMs, deadline ?? Infinity);
  const recovery = { method: 'GET', attempts: [], maxAttempts, totalTimeoutMs, writesReplayed: 0 };
  let lastError;
  const record = async entry => {
    recovery.attempts.push(entry);
    try { await onRecovery?.(sanitizeEvidence(entry)); }
    catch (error) {
      recovery.stopReason = 'recovery-evidence-failed';
      error.observationRecovery = recovery;
      throw error;
    }
  };
  const stop = reason => {
    recovery.stopReason = reason;
    const error = lastError ?? Object.assign(new Error('Cloud observation deadline exceeded.'), { code: 'CLOUD_OBSERVATION_TIMEOUT' });
    error.observationRecovery = recovery;
    throw error;
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signal?.throwIfAborted();
    const remaining = Math.floor(until - performance.now());
    if (remaining < 100) stop('deadline');
    try {
      const response = await client.request(path, undefined, { timeoutMs: Math.min(timeoutMs, remaining), signal });
      signal?.throwIfAborted();
      if (performance.now() >= until) stop('deadline');
      if (recovery.attempts.length) await record({ attempt, status: 'recovered', elapsedMs: Math.round(performance.now() - began) });
      signal?.throwIfAborted();
      if (performance.now() >= until) stop('deadline');
      return response;
    } catch (error) {
      signal?.throwIfAborted();
      if (error.observationRecovery === recovery) throw error;
      lastError = error;
      const status = error.publicFailure?.status;
      const code = error.publicFailure?.code ?? error.code;
      const causeCode = error.cause?.code;
      const denied = [401, 402, 403].includes(status);
      const transient = !denied && ([408, 425, 429, 500, 502, 503, 504].includes(status) ||
        (status === undefined && (error.name === 'TimeoutError' || code === 'CLOUD_REQUEST_UNCERTAIN' ||
          ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
            'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'].includes(code ?? causeCode))));
      const retryAfterMs = Number.isFinite(error.publicFailure?.retryAfterSeconds)
        ? Math.max(0, Math.ceil(error.publicFailure.retryAfterSeconds * 1000)) : 0;
      const waitMs = Math.max(Math.min(2000, 500 * 2 ** (attempt - 1)), retryAfterMs);
      const reason = denied ? 'authorization-or-quota-denied' : !transient ? 'non-transient-failure' :
        attempt === maxAttempts ? 'attempt-limit' : performance.now() + waitMs + 100 >= until ? 'deadline' : undefined;
      await record({ attempt, status: reason ? 'stopped' : 'retrying-read-only', elapsedMs: Math.round(performance.now() - began),
        failure: { source: error.publicFailure ? 'cloud-response' : 'transport', name: error.name,
          ...(code ? { code } : {}), ...(causeCode ? { causeCode } : {}),
          ...(error.publicFailure ? { publicFailure: error.publicFailure } : {}) },
        ...(reason ? { reason } : { waitMs }) });
      signal?.throwIfAborted();
      if (reason) stop(reason);
      await delay(waitMs, undefined, { signal: signal ?? undefined });
    }
  }
}

/** One hidden JSON line. Neither credentials nor terminal input are printed. */
export async function readHiddenCredentials({ signal } = {}) {
  signal?.throwIfAborted();
  const input = process.stdin;
  const wasRaw = input.isRaw;
  if (input.isTTY) input.setRawMode(true);
  let bytes = Buffer.alloc(0);
  try {
    const line = await new Promise((resolve, reject) => {
      const finish = (error, value) => {
        input.removeListener('data', data);
        input.removeListener('end', end);
        input.removeListener('error', fail);
        signal?.removeEventListener('abort', abort);
        input.pause();
        if (error) reject(error); else resolve(value);
      };
      const fail = () => finish(new Error('Credential input unavailable.'));
      const end = () => finish(new Error('A complete hidden credential line is required.'));
      const abort = () => finish(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
      const data = chunk => {
        for (const byte of Buffer.from(chunk)) {
          if (input.isTTY && byte === 3) { finish(new DOMException('Cancelled', 'AbortError')); return; }
          if (byte === 10 || byte === 13) { finish(undefined, bytes.toString('utf8')); return; }
          if (input.isTTY && (byte === 127 || byte === 8)) { bytes = bytes.subarray(0, Math.max(0, bytes.length - 1)); continue; }
          if (bytes.length >= 16_384) { finish(new Error('Credential input exceeds its bound.')); return; }
          bytes = Buffer.concat([bytes, Buffer.from([byte])]);
        }
      };
      input.on('data', data);
      input.once('end', end);
      input.once('error', fail);
      signal?.addEventListener('abort', abort, { once: true });
      input.resume();
    });
    let credentials;
    try { credentials = JSON.parse(line); } catch { throw new Error('Credential input must be one JSON line.'); }
    if (!credentials || typeof credentials.user_name !== 'string' || !credentials.user_name.trim() ||
        typeof credentials.password !== 'string' || !credentials.password || Object.keys(credentials).some(key => !['user_name', 'password'].includes(key))) {
      throw new Error('Credential input requires user_name and password only.');
    }
    return credentials;
  } finally {
    bytes.fill(0);
    if (input.isTTY) input.setRawMode(Boolean(wasRaw));
  }
}

/** Ordinary account login/BFF transport. Cookies, access token, CSRF and scope stay in this closure. */
export function createCloudAccountClient({ origin = 'https://harness.daoyintech.com', application = 'saishi', signal } = {}) {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Cloud origin must be a credential-free HTTPS origin.');
  }
  if (!['saishi', 'story'].includes(application)) throw new Error('An ordinary authenticated workbench is required.');
  origin = parsed.origin;
  const base = `/api/agent-apps/${application}/workbench`;
  const cookies = new Map();
  let csrf = '';
  let scope = '';
  let authenticated = false;
  let closed = false;
  let busyLogin = false;

  async function call(path, body, { timeoutMs = 20_000, signal: selectedSignal, authorization } = {}) {
    if (closed) throw new Error('Cloud client is closed.');
    const parent = selectedSignal === null ? undefined : selectedSignal ?? signal;
    parent?.throwIfAborted();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 650_000) throw new Error('Invalid request timeout.');
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('..') || path.includes('\0') || /[?#\\]/u.test(path.split('?')[0])) {
      throw new Error('Invalid same-origin request path.');
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const requestSignal = parent ? AbortSignal.any([parent, deadline]) : deadline;
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/json', Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(authorization ? { Authorization: authorization } : {}),
        ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
        ...(path.startsWith(base + '/') && scope ? { 'x-agent-account': scope, 'x-agent-csrf': csrf } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: requestSignal,
    });
    for (const entry of response.headers.getSetCookie()) {
      const parts = entry.split(';'); const separator = parts[0].indexOf('=');
      if (separator < 1 || !parts.some(part => part.trim().toLowerCase() === 'secure')) continue;
      const name = parts[0].slice(0, separator); const value = parts[0].slice(separator + 1);
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(name) || /[\r\n;]/u.test(value)) continue;
      if (parts.some(part => /^max-age=0$/iu.test(part.trim()))) cookies.delete(name); else cookies.set(name, value);
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > 3_000_000) { await response.body?.cancel().catch(() => {}); throw new Error('Cloud response exceeds its bound.'); }
      chunks.push(Buffer.from(chunk));
    }
    const retryAfter = response.headers.get('retry-after');
    const retryAfterSeconds = retryAfter && /^[0-9]{1,8}$/u.test(retryAfter) ? Number(retryAfter) :
      retryAfter && Number.isFinite(Date.parse(retryAfter)) ? Math.max(0, (Date.parse(retryAfter) - Date.now()) / 1000) : undefined;
    const retryAfterReceipt = retryAfterSeconds === undefined ? {} : { retryAfterSeconds };
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
      if (!response.ok) throw Object.assign(new Error('Cloud HTTP request failed before a JSON response.'), {
        code: 'HTTP_ERROR', publicFailure: { status: response.status, path, code: 'HTTP_ERROR', jsonResponse: false, ...retryAfterReceipt },
      });
      throw Object.assign(new Error('Cloud response is not JSON.'), { code: 'CLOUD_RESPONSE_NOT_JSON' });
    }
    if (!response.ok) {
      const candidate = result?.error?.code ?? result?.detail?.code;
      const code = typeof candidate === 'string' && /^[A-Z0-9_]{1,100}$/u.test(candidate) ? candidate : 'HTTP_ERROR';
      throw Object.assign(new Error('Cloud HTTP request failed.'), { code, publicFailure: { status: response.status, path, code,
        ...retryAfterReceipt } });
    }
    requestSignal.throwIfAborted();
    return { status: response.status, result };
  }

  return {
    origin, base,
    async login(credentials) {
      if (closed || authenticated || busyLogin) throw new Error('Cloud client cannot repeat login.');
      busyLogin = true;
      let login;
      try {
        if (!credentials || typeof credentials.user_name !== 'string' || typeof credentials.password !== 'string') {
          throw new Error('Real account credentials are required.');
        }
        login = await call('/api/auth/login', { user_name: credentials.user_name, password: credentials.password });
        if (typeof login.result.access_token !== 'string' || !login.result.access_token) throw new Error('Account login did not return a usable token.');
        await call('/api/auth/account-session', null, { authorization: `Bearer ${login.result.access_token}` });
        login.result.access_token = '';
        const boot = await call(base + '/bootstrap', {});
        if (boot.result.profileId !== 'daoyin-workbench' || boot.result.authentication !== 'account' ||
            typeof boot.result.csrfToken !== 'string' || !boot.result.csrfToken ||
            typeof boot.result.accountScope !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/u.test(boot.result.accountScope) ||
            !Number.isFinite(boot.result.expiresAt) || boot.result.expiresAt <= Date.now()) throw new Error('Ordinary account workbench is unavailable.');
        csrf = boot.result.csrfToken; scope = boot.result.accountScope; authenticated = true;
        return sanitizeEvidence({ profileId: boot.result.profileId, authentication: boot.result.authentication,
          account: boot.result.account, credits: boot.result.credits, expiresAt: boot.result.expiresAt });
      } catch (error) { csrf = ''; scope = ''; cookies.clear(); throw error; }
      finally {
        busyLogin = false;
        if (credentials) { credentials.password = ''; credentials.user_name = ''; }
        if (login?.result) login.result.access_token = '';
      }
    },
    request(path, body, options) {
      if (!authenticated) throw new Error('Ordinary account login is required before cloud requests.');
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.startsWith('/api/')) {
        throw new Error('Use a workbench-relative endpoint.');
      }
      return call(base + path, body, options);
    },
    close() { closed = true; authenticated = false; csrf = ''; scope = ''; cookies.clear(); },
  };
}
