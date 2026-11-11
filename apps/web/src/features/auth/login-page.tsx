import { useQuery } from "@tanstack/react-query";
import { authClient } from "../../lib/api.ts";
import { strings } from "../../lib/strings.vi.ts";
import { providersQuery } from "./use-session.ts";

export function LoginPage({ error }: { error?: string }) {
  const providers = useQuery(providersQuery);
  const list = providers.data?.providers ?? [];
  return (
    <main className="page">
      <h1>{strings.appName}</h1>
      <p className="muted">{strings.login.prompt}</p>
      {error ? (
        <p role="alert" className="error">
          {strings.login.errors[error] ?? strings.login.failed}
        </p>
      ) : null}
      {providers.isError ? (
        <p role="alert" className="error">
          {strings.login.unavailable}
        </p>
      ) : null}
      <div className="stack">
        {list.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => void authClient.signIn.social({ provider: id, callbackURL: "/" })}
          >
            {strings.login.with(strings.providerNames[id] ?? id)}
          </button>
        ))}
        {providers.isSuccess && list.length === 0 ? (
          <p className="muted">{strings.login.noProvider}</p>
        ) : null}
      </div>
    </main>
  );
}
