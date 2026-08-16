// The same design, composed correctly: the -trigger ancestor is present so the chip is live, the
// dialog root is not used as a container, text is wrapped, and the repeater loop is owned in
// customer code with R2 feeding each row its commentId.
import {
  VeltCommentDialogStatusDropdown,
  VeltCommentDialogStatusDropdownTrigger,
  VeltCommentDialogStatusDropdownTriggerIcon,
  VeltCommentDialogStatusDropdownTriggerName,
  VeltCommentDialogThreadCard,
  VeltCommentDialogThreadCardName,
} from '@veltdev/react';

export function LiveChip({ annotationId, comments }) {
  const config = useCommentDialogConfig({ annotationId });
  return (
    <div className="dialog" data-annotation-id={annotationId}>
      <VeltCommentDialogStatusDropdown annotationId={annotationId}>
        <VeltCommentDialogStatusDropdownTrigger>
          <VeltCommentDialogStatusDropdownTriggerIcon />
          <VeltCommentDialogStatusDropdownTriggerName />
        </VeltCommentDialogStatusDropdownTrigger>
      </VeltCommentDialogStatusDropdown>
      {comments.map((c) => (
        <VeltCommentDialogThreadCard key={c.commentId} commentId={c.commentId}>
          <VeltCommentDialogThreadCardName><span>Unassigned</span></VeltCommentDialogThreadCardName>
        </VeltCommentDialogThreadCard>
      ))}
    </div>
  );
}
