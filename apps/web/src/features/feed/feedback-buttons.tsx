import { useMutation } from "@tanstack/react-query";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { getFeedClient } from "../../lib/feed-client.ts";
import { strings } from "../../lib/strings.vi.ts";
import { IconButton } from "../../ui/index.ts";
import type { FeedbackKind, FeedbackState } from "./types.ts";
import { useFeedbackPatch } from "./use-feed.ts";

/**
 * 👍/👎: bấm lại đúng nút đang chọn thì bỏ (server làm việc đó; ở đây tính trước để hiện ngay).
 * Cập nhật lạc quan, hoàn lại nếu lỗi, lấy trạng thái server trả về làm chuẩn; khoá khi đang gửi.
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
    // biome-ignore lint/a11y/useSemanticElements: nhóm hai nút icon có aria-label, không cần fieldset
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
