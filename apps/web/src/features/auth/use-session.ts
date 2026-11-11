import { useQuery } from "@tanstack/react-query";
import { api, HttpError } from "../../lib/api.ts";
import { queryKeys } from "../../lib/query-keys.ts";

export const sessionQuery = {
  queryKey: queryKeys.me,
  queryFn: async () => {
    const res = await api.me.$get();
    if (!res.ok) throw new HttpError(res.status);
    return res.json();
  },
  retry: false,
  staleTime: 60_000,
};

export const providersQuery = {
  queryKey: queryKeys.providers,
  queryFn: async () => {
    const res = await api.providers.$get();
    if (!res.ok) throw new HttpError(res.status);
    return res.json();
  },
  retry: false,
  staleTime: Number.POSITIVE_INFINITY,
};

export const useSession = () => useQuery(sessionQuery);
