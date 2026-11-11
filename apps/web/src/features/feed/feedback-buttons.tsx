import { useMutation } from "@tanstack/react-query";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { getFeedClient } from "../../lib/feed-client.ts";
import { strings } from "../../lib/strings.vi.ts";
import { IconButton } from "../../ui/index.ts";
import type { FeedFeedbackKind } from "./types.ts";
import { useFeedbackPatch } from "./use-feed.ts";

/** 👍/👎: bấm lại đúng nút đang chọn để bỏ. Cập nhật lạc quan, hoàn lại nếu lỗi; khoá khi đang gửi. */
export function FeedbackButtons({
  feedItemId,
  value,
}: {
  feedItemId: number;
  value: FeedFeedbackKind | null;
}) {
  const patch = useFeedbackPatch();
  const m = useMutation({
    mutationFn: async (kind: FeedFeedbackKind | "clear") =>
      (await getFeedClient()).putFeedback({ feedItemId, kind }),
    onMutate: (kind) => patch(feedItemId, kind === "clear" ? null : kind),
    onError: (_e, _k, revert) => revert?.(),
  });
  const press = (k: FeedFeedbackKind) => m.mutate(value === k ? "clear" : k);
  return (
    // biome-ignore lint/a11y/useSemanticElements: nhóm hai nút icon có aria-label, không cần fieldset
    <div className="fb-group" role="group" aria-label={strings.feed.feedback.group}>
      <IconButton
        label={strings.feed.feedback.up}
        pressed={value === "up"}
        disabled={m.isPending}
        onClick={() => press("up")}
      >
        <ThumbsUp aria-hidden />
      </IconButton>
      <IconButton
        label={strings.feed.feedback.down}
        pressed={value === "down"}
        disabled={m.isPending}
        onClick={() => press("down")}
      >
        <ThumbsDown aria-hidden />
      </IconButton>
    </div>
  );
}
