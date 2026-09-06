import { useState } from "react";
import type { AccountProfile } from "./client.js";

export function AccountIdentity({ account }: { account: AccountProfile }): React.JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string>();
  return <div className="account-identity" aria-label="当前账号">
    <span className="account-avatar" aria-hidden="true">
      {account.avatarUrl && account.avatarUrl !== failedUrl
        ? <img src={account.avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(account.avatarUrl ?? undefined)} />
        : Array.from(account.username)[0]?.toUpperCase()}
    </span>
    <span className="account-username" title={account.username}>{account.username}</span>
  </div>;
}
