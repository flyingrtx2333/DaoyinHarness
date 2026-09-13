import { useEffect, useState } from "react";
import { HarnessLogo } from "./HarnessLogo.js";
import heroImage from "../../public/assets/login-hero-ribbon-v2.png";
import heroVideo from "../../public/assets/login-hero-ribbon-loop-v1.mp4";

const PLATFORM = "https://www.daoyintech.com";
const API = "/api";
const REGISTER_URL = `${PLATFORM}/login?mode=register&redirect=harness&app=saishi`;
const HERO_IMAGE = heroImage;
const HERO_VIDEO = heroVideo;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validMainlandPhone(value: string): boolean {
  return /^1[3-9]\d{9}$/u.test(value.trim());
}

export function publicAuthError(value: unknown, fallback: string): string {
  if (!record(value)) return fallback;
  if (typeof value.detail === "string" && value.detail.trim()) return value.detail.trim().slice(0, 240);
  if (record(value.detail) && typeof value.detail.message === "string" && value.detail.message.trim()) return value.detail.message.trim().slice(0, 240);
  if (typeof value.message === "string" && value.message.trim()) return value.message.trim().slice(0, 240);
  return fallback;
}

async function json(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export function LoginGateway(): React.JSX.Element {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [motionEnabled, setMotionEnabled] = useState(true);
  const [videoReady, setVideoReady] = useState(false);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown(value => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncMotion = (): void => setMotionEnabled(!preference.matches);
    syncMotion();
    preference.addEventListener?.("change", syncMotion);
    return () => preference.removeEventListener?.("change", syncMotion);
  }, []);

  async function sendCode(): Promise<void> {
    if (sending || countdown > 0) return;
    if (!validMainlandPhone(phone)) { setError("请输入有效的中国大陆手机号"); return; }
    setSending(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${API}/auth/sms/send`, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ phone: phone.trim(), scene: "login" }),
      });
      const result = await json(response);
      if (!response.ok) throw new Error(publicAuthError(result, "验证码发送失败，请稍后重试。"));
      const retry = record(result) && typeof result.retry_after_seconds === "number" && Number.isFinite(result.retry_after_seconds)
        ? Math.min(120, Math.max(1, Math.round(result.retry_after_seconds))) : 60;
      setCountdown(retry); setNotice("验证码已发送，5 分钟内有效");
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "验证码发送失败，请检查网络后重试。");
    } finally { setSending(false); }
  }

  async function login(): Promise<void> {
    if (submitting) return;
    if (!validMainlandPhone(phone)) { setError("请输入有效的中国大陆手机号"); return; }
    if (!/^\d{6}$/u.test(code)) { setError("请输入 6 位短信验证码"); return; }
    if (!agreed) { setError("请先确认使用道引统一账号登录"); return; }
    setSubmitting(true); setError(""); setNotice("");
    try {
      const loginResponse = await fetch(`${API}/auth/sms-login`, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ phone: phone.trim(), sms_code: code }),
      });
      const loginResult = await json(loginResponse);
      if (!loginResponse.ok) throw new Error(publicAuthError(loginResult, "登录失败，请检查验证码后重试。"));
      const accessToken = record(loginResult) && typeof loginResult.access_token === "string" && loginResult.access_token.length <= 8192
        ? loginResult.access_token : "";
      if (!accessToken) throw new Error("登录结果无效，请重新获取验证码。");
      const sessionResponse = await fetch(`${API}/auth/account-session`, {
        method: "POST", credentials: "include", cache: "no-store", redirect: "error",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      if (!sessionResponse.ok) throw new Error(publicAuthError(await json(sessionResponse), "账号连接未完成，请重新登录。"));
      setNotice("登录成功，正在进入 Harness…");
      window.location.replace("/");
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "登录未完成，请检查网络后重试。");
    } finally { setSubmitting(false); }
  }

  return <main className="login-gateway">
    <header className="login-brand"><HarnessLogo aria-hidden="true" /><strong>道引 Harness</strong></header>
    <section className={`login-story${videoReady ? " login-story-video-ready" : ""}`} aria-labelledby="login-story-title">
      <video
        className="login-story-video"
        src={motionEnabled ? HERO_VIDEO : undefined}
        poster={HERO_IMAGE}
        autoPlay={motionEnabled}
        muted
        loop
        playsInline
        preload="metadata"
        onPlaying={() => setVideoReady(true)}
        onPause={() => setVideoReady(false)}
        aria-hidden="true"
        tabIndex={-1}
      />
      <div className="login-aurora" aria-hidden="true"><span /><span /></div>
      <div className="login-story-copy">
        <h1 id="login-story-title">与 AI 一起，<br />把想法变成成果</h1>
        <p>统一的 AI Agent 工作平台</p>
      </div>
    </section>
    <section className="login-panel" aria-labelledby="login-title">
      <div className="login-card">
        <h2 id="login-title">登录 Harness</h2>
        {error && <div className="login-message login-error" role="alert">{error}</div>}
        {notice && <div className="login-message login-notice" role="status">{notice}</div>}
        <form onSubmit={event => { event.preventDefault(); void login(); }}>
          <label className="login-field"><span>手机号</span><span className="login-phone"><b>+86</b><input value={phone} onChange={event => setPhone(event.target.value.replace(/\D/gu, "").slice(0, 11))} type="tel" inputMode="numeric" autoComplete="tel" placeholder="请输入手机号" disabled={submitting} /></span></label>
          <label className="login-field"><span>验证码</span><span className="login-code"><input value={code} onChange={event => setCode(event.target.value.replace(/\D/gu, "").slice(0, 6))} type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="请输入短信验证码" disabled={submitting} /><button type="button" onClick={() => { void sendCode(); }} disabled={sending || submitting || countdown > 0}>{sending ? "发送中…" : countdown > 0 ? `${countdown} 秒后重试` : "获取验证码"}</button></span></label>
          <button className="login-submit" type="submit" disabled={submitting}>{submitting ? "正在登录…" : "登录并进入 Harness"}</button>
          <label className="login-agreement"><input type="checkbox" checked={agreed} onChange={event => setAgreed(event.target.checked)} disabled={submitting} /><span>我已了解并同意使用道引统一账号完成登录</span></label>
        </form>
        <p className="login-register">还没有道引账号？<a href={REGISTER_URL}>注册账号</a></p>
      </div>
    </section>
  </main>;
}
