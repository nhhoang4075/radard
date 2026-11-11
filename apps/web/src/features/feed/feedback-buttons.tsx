import { useMutation } from "@tanstack/react-query";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { getFeedClient } from "../../lib/feed-client.ts";
import { strings } from "../../lib/strings.vi.ts";
import { IconButton } from "../../ui/index.ts";
import type { FeedbackKind, FeedbackState } from "./types.ts";
import { useFeedbackPatch } from "./use-feed.ts";

/**
 * 👍/👎: tapping the selected button again clears it (the server does that; it is computed here first so it shows at once).
 * Optimistic update, rolled back on error, the server's returned state is the source of truth; locked while sending.
 */
export function FeedbackButtons({
  feedItemId,
  value,
}: {
  feedItemId: number;
  value: FeedbackState;
}) {
  const patch = useFeedbackPatch();
  const m = useMutation({
    mutationFn: (kind: FeedbackKind) => getFeedClient().putFeedback({ feedItemId, kind }),
    onMutate: (kind) => patch(feedItemId, value === kind ? "none" : kind),
    onSuccess: (state) => patch(feedItemId, state),
    onError: (_e, _k, revert) => revert?.(),
  });
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of two icon buttons with aria-label, no fieldset needed
    <div className="fb-group" role="group" aria-label={strings.feed.feedback.group}>
      <IconButton
        label={strings.feed.feedback.up}
        pressed={value === "like"}
        disabled={m.isPending}
        onClick={() => m.mutate("like")}
      >
        <ThumbsUp aria-hidden />
      </IconButton>
      <IconButton
        label={strings.feed.feedback.down}
        pressed={value === "dislike"}
        disabled={m.isPending}
        onClick={() => m.mutate("dislike")}
      >
        <ThumbsDown aria-hidden />
      </IconButton>
    </div>
  );
}
