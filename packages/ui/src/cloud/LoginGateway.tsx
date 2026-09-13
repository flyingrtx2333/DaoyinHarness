import { useEffect, useState } from "react";
import { HarnessLogo } from "./HarnessLogo.js";
import { WorkbenchIcon } from "./WorkbenchIcon.js";

const PLATFORM = "https://www.daoyintech.com";
const API = "/api";
const REGISTER_URL = `${PLATFORM}/login?mode=register&redirect=harness&app=saishi`;

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

export function LoginGateway({ fallbackLoginUrl }: { fallbackLoginUrl: string }): React.JSX.Element {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown(value => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

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
    <section className="login-story" aria-labelledby="login-story-title">
      <div className="login-aurora" aria-hidden="true"><span /><span /></div>
      <div className="login-story-copy">
        <h1 id="login-story-title">与 AI 一起，<br />把想法变成成果</h1>
        <p>道引 Harness · 统一的 AI Agent 工作平台<br />支持创作、研究、业务工具与自动化流程，<br />让每个人与团队更高效地完成工作。</p>
        <ul>
          <li><span><WorkbenchIcon name="edit" /></span><b>内容创作</b><small>灵感即刻成文</small></li>
          <li><span><WorkbenchIcon name="search" /></span><b>深度研究</b><small>从信息到洞见</small></li>
          <li><span><WorkbenchIcon name="plugin" /></span><b>业务工具</b><small>连接你的业务</small></li>
          <li><span><WorkbenchIcon name="connection" /></span><b>自动化流程</b><small>让工作自运行</small></li>
        </ul>
      </div>
      <p className="login-story-foot">更强的个体 · 更高效的团队 · 更智能的未来</p>
    </section>
    <section className="login-panel" aria-labelledby="login-title">
      <div className="login-card">
        <div className="login-card-brand"><HarnessLogo aria-hidden="true" /><span>道引 Harness</span></div>
        <h2 id="login-title">欢迎使用道引</h2>
        <p className="login-subtitle">使用道引统一账号登录 Harness</p>
        {error && <div className="login-message login-error" role="alert">{error}</div>}
        {notice && <div className="login-message login-notice" role="status">{notice}</div>}
        <form onSubmit={event => { event.preventDefault(); void login(); }}>
          <label className="login-field"><span>手机号</span><span className="login-phone"><b>+86</b><input value={phone} onChange={event => setPhone(event.target.value.replace(/\D/gu, "").slice(0, 11))} type="tel" inputMode="numeric" autoComplete="tel" placeholder="请输入手机号" disabled={submitting} /></span></label>
          <label className="login-field"><span>验证码</span><span className="login-code"><input value={code} onChange={event => setCode(event.target.value.replace(/\D/gu, "").slice(0, 6))} type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="请输入短信验证码" disabled={submitting} /><button type="button" onClick={() => { void sendCode(); }} disabled={sending || submitting || countdown > 0}>{sending ? "发送中…" : countdown > 0 ? `${countdown} 秒后重试` : "获取验证码"}</button></span></label>
          <button className="login-submit" type="submit" disabled={submitting}>{submitting ? "正在登录…" : "登录并进入 Harness"}</button>
          <label className="login-agreement"><input type="checkbox" checked={agreed} onChange={event => setAgreed(event.target.checked)} disabled={submitting} /><span>我已了解并同意使用道引统一账号完成登录</span></label>
        </form>
        <p className="login-register">还没有道引账号？<a href={REGISTER_URL}>注册账号</a></p>
        <div className="login-divider" />
        <a className="login-fallback" href={fallbackLoginUrl}>使用主平台登录页</a>
      </div>
    </section>
  </main>;
}
