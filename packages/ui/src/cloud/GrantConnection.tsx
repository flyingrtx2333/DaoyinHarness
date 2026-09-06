import { useState } from "react";
import "./grant-connection.css";

export function GrantConnection({ onConnect, busy }: { onConnect: (token: string) => Promise<void>; busy: boolean }): React.JSX.Element {
  const [token, setToken] = useState("");
  return <form className="grant-connection" onSubmit={(event) => {
    event.preventDefault();
    if (!token.trim() || busy) return;
    const value = token.trim();
    setToken(""); // Credentials never enter messages, browser storage, receipts or console output.
    void onConnect(value);
  }}>
    <label htmlFor="saishi-grant">赛事只读授权</label>
    <div><input id="saishi-grant" type="password" autoComplete="off" spellCheck={false} value={token}
      onChange={(event) => setToken(event.target.value)} placeholder="粘贴赛事后台签发的授权" maxLength={100}
      disabled={busy} aria-describedby="saishi-grant-help" />
      <button className="primary" type="submit" disabled={busy || !token.trim()}>连接授权</button></div>
    <p id="saishi-grant-help">在赛事后台「Agent 授权」中选择赛事，并开启云端模型用量授权。不要将凭证发进聊天。</p>
  </form>;
}
