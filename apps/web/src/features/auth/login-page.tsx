import { useQuery } from "@tanstack/react-query";
import { authClient } from "../../lib/api.ts";
import { strings } from "../../lib/strings.vi.ts";
import { Button } from "../../ui/index.ts";
import "./auth.css";
import { providersQuery } from "./use-session.ts";

export function LoginPage({ error }: { error?: string }) {
  const providers = useQuery(providersQuery);
  const list = providers.data?.providers ?? [];
  return (
    <main className="auth-page">
      <h1>{strings.appName}</h1>
      <p className="rd-muted">{strings.login.prompt}</p>
      {error ? (
        <p role="alert" className="auth-error">
          {strings.login.errors[error] ?? strings.login.failed}
        </p>
      ) : null}
      {providers.isError ? (
        <p role="alert" className="auth-error">
          {strings.login.unavailable}
        </p>
      ) : null}
      <div className="auth-stack">
        {list.map((id) => (
          <Button
            key={id}
            variant="secondary"
            onClick={() => void authClient.signIn.social({ provider: id, callbackURL: "/" })}
          >
            {strings.login.with(strings.providerNames[id] ?? id)}
          </Button>
        ))}
        {providers.isSuccess && list.length === 0 ? (
          <p className="rd-muted">{strings.login.noProvider}</p>
        ) : null}
      </div>
    </main>
  );
}
