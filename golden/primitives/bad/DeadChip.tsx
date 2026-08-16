// Reproduces PR snippyly/sdk#4506 open issues #3 and #4: the "Velt Primitives Lab" composed a status
// chip from the -trigger-icon + -trigger-name leaves, skipping the -trigger that carries the click
// handler. It rendered pixel-correct and did nothing. This is the shape a code generator produces
// when it reads a design as "an icon and a label".
import {
  VeltCommentDialog,
  VeltCommentDialogStatusDropdown,
  VeltCommentDialogStatusDropdownTriggerIcon,
  VeltCommentDialogStatusDropdownTriggerName,
  VeltCommentDialogThreadCardName,
  VeltCommentDialogThreadCardComments,
} from '@veltdev/react';

export function DeadChip({ annotationId, comments }) {
  const config = useCommentSidebarConfig({ annotationId });
  return (
    <VeltCommentDialog annotationId={annotationId}>
      <VeltCommentDialogStatusDropdown annotationId={annotationId}>
        <VeltCommentDialogStatusDropdownTriggerIcon />
        <VeltCommentDialogStatusDropdownTriggerName />
      </VeltCommentDialogStatusDropdown>
      <VeltCommentDialogThreadCardName>Unassigned</VeltCommentDialogThreadCardName>
      <VeltCommentDialogThreadCardComments>
        <div className="row" />
      </VeltCommentDialogThreadCardComments>
    </VeltCommentDialog>
  );
}
